import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { canRememberFolders, readFolder } from '../../utils/abletonLibrary';
import type { ProjectFile } from '../../utils/abletonImport';
import type { JamImportStep } from './jamAbletonImport';

// Importing an Ableton project's folder, as the Daw lobby's card and the Daw's
// toolbar do it: the folder picked (remembered where the browser can, else
// from a folder input), read as the Lessons tab reads it and imported, with
// the import's step while it runs and why the last one failed.
export function useAbletonImport(onImport: (files: ProjectFile[], onStep: (step: JamImportStep) => void) => Promise<void>) {
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<JamImportStep | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => input.current?.setAttribute('webkitdirectory', ''), []);

  const run = async (files: ProjectFile[]) => {
    setProblem(null);
    try {
      await onImport(files, setStep);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setStep(null);
    }
  };

  const pick = async () => {
    if (step) return;
    if (!canRememberFolders()) {
      input.current?.click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker!({ id: 'ableton-project', mode: 'read' });
      setStep({ stage: 'reading' });
      await run(await readFolder(handle));
    } catch (error) {
      setStep(null);
      if (!(error instanceof DOMException && error.name === 'AbortError')) setProblem(String(error));
    }
  };

  // The folder input, hidden, for browsers that cannot remember a folder
  const inputProps = {
    ref: input,
    type: 'file',
    hidden: true,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []).map((file) => ({ path: file.webkitRelativePath, file }));
      event.target.value = '';
      if (files.length) run(files);
    },
  };

  // How far along the import is (0-1)
  const share = step && step.stage !== 'reading' ? step.done / step.total : 0;
  return { pick, inputProps, step, share, problem };
}
