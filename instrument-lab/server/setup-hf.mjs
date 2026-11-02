import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const python=path.join(root,'.venv-hf/bin/python');
for(const args of [['venv','--allow-existing','--python','3.11',path.join(root,'.venv-hf')],['pip','install','--python',python,'huggingface_hub==2.1.1']]) {
 const run=spawnSync(process.env.UV_PATH || 'uv',args,{stdio:'inherit'});
 if(run.error || run.status!==0) {console.error(run.error?.message || 'HF client setup failed');process.exit(1)}
}
console.log('Hugging Face Jobs client installed. Existing HF login is used only by the server.');
