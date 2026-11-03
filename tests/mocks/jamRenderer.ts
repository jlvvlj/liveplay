// Stand-in for the Jam sound renderer (a module worker Jest cannot load)
export const renderJamSound = (): Promise<{ [note: number]: string }> => new Promise(() => {});
