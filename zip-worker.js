importScripts('./vendor/jszip.min.js');
onmessage = async ({data:{action, buffer, path, limit}}) => {
  try {
    if (action === 'open') {
      const bytes = new Uint8Array(buffer);
      if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) throw Error();
      self.archive = await JSZip.loadAsync(buffer);
      if (Object.keys(archive.files).length > 2500) throw Error();
      postMessage(true);
      return;
    }
    const entry = archive.file(path);
    if (!entry) { postMessage(null); return; }
    const chunks = [];
    let size = 0;
    let stopped = false;
    const stream = entry.internalStream('uint8array');
    stream.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        stopped = true;
        stream.pause();
        postMessage({error:true});
      } else chunks.push(chunk);
    }).on('error', () => {
      if (!stopped) postMessage({error:true});
    }).on('end', () => {
      if (!stopped) postMessage(new Blob(chunks));
    }).resume();
  } catch {
    postMessage({error:true});
  }
};
