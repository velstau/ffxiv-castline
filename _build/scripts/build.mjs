import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './icons.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pub = join(root, '../public');
mkdirSync(join(pub, 'vendor/tabler'), { recursive: true });
mkdirSync(join(pub, 'licenses'), { recursive: true });
for (const type of ['css', 'js']) {
    copyFileSync(join(root, `node_modules/@tabler/core/dist/${type}/tabler.min.${type}`), join(pub, `vendor/tabler/tabler.min.${type}`));
}
copyFileSync(join(root, 'src/app.css'), join(pub, 'css/app.css'));
copyFileSync(join(root, 'licenses/tabler-MIT.txt'), join(pub, 'licenses/tabler-MIT.txt'));
copyFileSync(join(root, 'node_modules/@tabler/icons/LICENSE'), join(pub, 'licenses/tabler-icons-MIT.txt'));
console.log('Tabler CSS/JS, tool styles and licenses built.');
