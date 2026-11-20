// Hash of the board shell. A feed tick does not change it. A new index.html does.
import { createHash } from 'node:crypto';

export const SHELL_FILES = ['index.html', 'live.js', 'live-config.js', 'site-config.js'];
export const SHELL_HEADER = 'X-Bifrost-Shell';

export function shellVersion(files) {
  const hash = createHash('sha256');
  for (const name of SHELL_FILES) {
    hash.update(name);
    hash.update('\0');
    const body = files && files[name];
    if (body) hash.update(body);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
