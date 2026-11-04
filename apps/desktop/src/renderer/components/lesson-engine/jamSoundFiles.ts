// Where the Jam tab's recorded sounds are served from: `file` is
// "softer/<name>.wav" (Softer Lesson) or "softer-jam/<name>.wav" (Softer Jam)
export const jamSoundUrl = (file: string): string => {
  const [folder, name] = file.split('/');
  if (folder === 'softer') return new URL(`./softer/${name}`, import.meta.url).href;
  if (folder === 'softer-jam') return new URL(`./softer-jam/${name}`, import.meta.url).href;
  throw new Error(`No recorded sound ${file}`);
};
