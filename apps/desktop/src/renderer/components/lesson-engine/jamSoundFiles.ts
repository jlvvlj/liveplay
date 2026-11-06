// Where the Jam tab's recorded sounds are served from: `file` is
// "softer/<name>.wav" (Softer Lesson), "softer-jam/<name>.wav" (Softer Jam) or
// "packs/<pack>/<name>.wav" (a sound pack, see jamPacks.ts)
export const jamSoundUrl = (file: string): string => {
  const [folder, name, packed] = file.split('/');
  if (folder === 'softer') return new URL(`./softer/${name}`, import.meta.url).href;
  if (folder === 'softer-jam') return new URL(`./softer-jam/${name}`, import.meta.url).href;
  if (folder === 'packs' && packed) return new URL(`./packs/${name}/${packed}`, import.meta.url).href;
  throw new Error(`No recorded sound ${file}`);
};
