// #304: servers under test bind port 0 and we read the port the OS assigned from the "listening on :N" line.
// (Guessed random ports collided across files and parallel runs; a probe-then-release port can be taken by a client socket.)
export function listenPort(proc, ms = 30000) {
  return new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('server never logged "listening on :N": ' + buf.slice(-500))), ms);
    const on = d => { buf += d; const m = /listening on :(\d+)/.exec(buf); if (m) { clearTimeout(t); proc.stdout.off('data', on); res(Number(m[1])); } };
    proc.stdout.on('data', on);
    proc.once('exit', c => { clearTimeout(t); rej(new Error('server exited ' + c + ': ' + buf.slice(-500))); });
  });
}
