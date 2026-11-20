const maxSlides = 40;
const children = (element, name) => [...(element?.children ?? [])].filter(node => node.localName === name);
const all = (element, name) => [...element.getElementsByTagNameNS('*', name)];
const value = (element, name) => element?.getAttribute(name) ?? '';
const titleFrom = (lines, index) => lines[0]?.slice(0, 140) || 'Página ' + (index + 1);

export async function openPdf(buffer) {
  const pdf = await import('./vendor/pdf/pdf.mjs');
  const asset = name => new URL('./vendor/pdf/' + name, import.meta.url).href;
  pdf.GlobalWorkerOptions.workerSrc = asset('pdf.worker.mjs');
  const task = pdf.getDocument({
    data: buffer, cMapUrl: asset('cmaps/'), cMapPacked:true, standardFontDataUrl: asset('standard_fonts/'),
    wasmUrl: asset('wasm/'), useWasm:false, isEvalSupported:false, enableXfa:false, maxImageSize:12_000_000
  });
  let document;
  try {
    document = await task.promise;
    if (document.numPages > maxSlides) throw Error('El PDF supera las 40 páginas. Divide el documento e inténtalo de nuevo.');
  } catch (error) {
    await task.destroy().catch(() => {});
    if (error.name === 'PasswordException') throw Error('Este PDF está protegido con contraseña. Abre una copia sin contraseña si tienes permiso.');
    throw error;
  }
  return {
    total:document.numPages, kind:'pdf', close:() => task.destroy().catch(() => {}),
    async page(index) {
      const page = await document.getPage(index + 1);
      const content = await page.getTextContent();
      const text = content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('').trim();
      const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
      return {
        title:titleFrom(lines, index), text:text.slice(0, 40000), notes:[], async visuals() {
          const natural = page.getViewport({scale:1});
          const viewport = page.getViewport({scale: Math.min(2, 1300 / Math.max(natural.width, natural.height))});
          const canvas = window.document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          await page.render({canvas, viewport}).promise;
          return [canvas];
        }
      };
    }
  };
}

export async function openPpt(buffer) {
  const worker = new Worker(new URL('./zip-worker.js', import.meta.url));
  let closed = false;
  let cancelRead;
  function close() {
    closed = true;
    worker.terminate();
    cancelRead?.();
  }
  function read(data, transfer = []) {
    return new Promise((resolve, reject) => {
      if (closed) { reject(Error('Archivo cerrado.')); return; }
      const finish = (error, payload) => {
        clearTimeout(timer);
        cancelRead = undefined;
        if (error) reject(Error('No se pudo leer una parte del PowerPoint o supera el límite de procesamiento.'));
        else resolve(payload);
      };
      const timer = setTimeout(close, 12000);
      cancelRead = () => finish(true);
      worker.onmessage = event => finish(event.data?.error, event.data);
      worker.onerror = () => finish(true);
      worker.postMessage(data, transfer);
    });
  }
  async function xml(path, optional = false) {
    const blob = await read({action:'read', path, limit:2_000_000});
    if (!blob && optional) return null;
    if (!blob) throw Error('Falta una parte necesaria del PowerPoint.');
    const source = await blob.text();
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw Error('El XML del PowerPoint contiene una declaración no admitida.');
    const parsed = new DOMParser().parseFromString(source, 'application/xml');
    if (parsed.querySelector('parsererror')) throw Error('El PowerPoint contiene XML ilegible.');
    return parsed;
  }
  function relations(doc, base) {
    const map = new Map();
    for (const item of doc ? all(doc, 'Relationship') : []) {
      if (value(item, 'TargetMode') === 'External') continue;
      const target = value(item, 'Target');
      if (!target || /[:\\?#]/.test(target)) continue;
      const pathname = new URL(target, 'https://archivo.invalid/' + base).pathname.slice(1);
      map.set(value(item, 'Id'), pathname);
    }
    return map;
  }
  const relationId = (element, name) => [...element.attributes].find(attribute => attribute.localName === name && attribute.namespaceURI?.endsWith('/relationships'))?.value;
  let paths;
  try {
    await read({action:'open', buffer}, [buffer]);
    const deck = await xml('ppt/presentation.xml');
    const map = relations(await xml('ppt/_rels/presentation.xml.rels'), 'ppt/presentation.xml');
    paths = all(deck, 'sldId').map(element => map.get(relationId(element, 'id')));
    if (!paths.length || paths.some(path => !/^ppt\/slides\/[^/]+\.xml$/i.test(path ?? ''))) throw Error('El documento PowerPoint no contiene páginas válidas.');
    if (paths.length > maxSlides) throw Error('El documento PowerPoint supera las 40 páginas.');
  } catch (error) { close(); throw error; }

  return {
    total:paths.length, kind:'pptx', close,
    async page(index) {
      const path = paths[index];
      const doc = await xml(path);
      const relPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
      const map = relations(await xml(relPath, true), path);
      const paragraphs = element => all(element, 'p').map(node => all(node, 't').map(item => item.textContent).join('').trim()).filter(Boolean);
      const lines = paragraphs(doc);
      const titleShape = all(doc, 'sp').find(shape => all(shape, 'ph').some(place => ['title','ctrTitle'].includes(value(place,'type'))));
      const pictures = all(doc, 'pic');
      const imagePaths = pictures.flatMap(pic => all(pic, 'blip')).map(blip => map.get(relationId(blip, 'embed')));
      const notes = pictures.map(pic => {
        const props = all(pic, 'cNvPr')[0];
        return value(props, 'descr') || value(props, 'title');
      }).filter(Boolean).map(note => 'Texto alternativo del archivo: ' + note.slice(0, 500));
      const graphs = all(doc, 'chart');
      if (pictures.length && !notes.length) notes.push('El PowerPoint contiene imágenes sin texto alternativo recuperado.');
      if (all(doc, 'graphicFrame').length > graphs.length) notes.push('El PowerPoint puede contener tablas, diagramas u otros objetos sin vista visual en este formato.');
      for (const graph of graphs.slice(0, 4)) {
        const target = map.get(relationId(graph, 'id'));
        if (!target?.startsWith('ppt/charts/')) continue;
        const chart = await xml(target, true);
        if (!chart) continue;
        const pointText = el => all(el,'pt').slice(0,24).map(item => children(item,'v')[0]?.textContent ?? '').join(', ');
        const series = all(chart,'ser').slice(0,5).map(serie => {
          const cat = children(serie,'cat')[0] || children(serie,'xVal')[0];
          const values = children(serie,'val')[0] || children(serie,'yVal')[0];
          const name = children(serie,'tx')[0];
          return [name && ('Serie: ' + name.textContent.trim().slice(0,100)), cat && ('Etiquetas: ' + pointText(cat)), values && ('Valores: ' + pointText(values))].filter(Boolean).join('. ');
        }).filter(Boolean);
        if (series.length) notes.push(('Datos extraídos del gráfico: ' + series.join(' | ')).slice(0,2200));
      }
      const visuals = [];
      const visualPaths = imagePaths.filter(path => /^ppt\/media\/[^/]+\.(png|jpeg|jpg|webp)$/i.test(path ?? '')).slice(0,3);
      for (const path of visualPaths) {
        const blob = await read({action:'read',path,limit:4_000_000});
        if (!blob) continue;
        const bitmap = await createImageBitmap(blob).catch(() => null);
        if (!bitmap) continue;
        const scale = Math.min(1,1000 / Math.max(bitmap.width,bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1,Math.round(bitmap.width * scale));
        canvas.height = Math.max(1,Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
        bitmap.close();
        visuals.push(canvas);
      }
      return {
        title:titleFrom(titleShape ? paragraphs(titleShape) : lines,index),
        text:lines.join('\n').slice(0,40000), notes:notes.slice(0,20), visuals:async () => visuals
      };
    }
  };
}

export async function openImage(file) {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const matches = (...bytes) => bytes.every((value, index) => header[index] === value);
  const png = matches(137,80,78,71,13,10,26,10);
  const jpeg = matches(255,216,255);
  const webp = matches(82,73,70,70)
    && String.fromCharCode(...header.slice(8,12)) === 'WEBP';
  if (!png && !jpeg && !webp) throw Error('Selecciona una imagen válida en PNG, JPEG o WebP.');

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw Error('La imagen está dañada o no se ha podido abrir.');
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, 1300 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
  return {
    kind:'image', total:1,
    close() { canvas.width = canvas.height = 0; },
    async page() {
      return {title:'Imagen', text:'', notes:[], visuals:async () => [canvas]};
    }
  };
}
