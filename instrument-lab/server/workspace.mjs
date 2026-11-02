// Analysis documents remain independently versioned; a song exposes one workspace.
// This preserves prior patches and assets without destructively migrating data.
export function workspaceRoot(project, projects) {
  if (project.engine !== "drum") return project;
  return (
    projects.find((p) => p.id === project.parentProjectId) ||
    projects.find(
      (p) =>
        p.engine !== "drum" &&
        p.sourceSongIds?.some((id) => project.sourceSongIds?.includes(id)),
    ) ||
    project
  );
}
export function workspaceMembers(root, projects) {
  return [
    root,
    ...projects.filter(
      (p) =>
        p.id !== root.id &&
        p.engine === "drum" &&
        (p.parentProjectId === root.id ||
          root.sourceSongIds?.some((id) => p.sourceSongIds?.includes(id))),
    ),
  ];
}
export function composeWorkspace(root, members) {
  const documents = members.filter((p) => p.result);
  const parts = documents.flatMap((p) =>
    p.result.parts.map((part) => ({
      ...part,
      id: p.id === root.id ? part.id : `${p.id}:${part.id}`,
      engine: part.engine || part.patch.engine || "melodic",
      ownerProjectId: p.id,
      ownerPartId: part.id,
      ownerRevision: p.revision,
    })),
  );
  const analyses = members.map(
    ({ id, engine, status, progress, message, revision }) => ({
      id,
      engine: engine || "melodic",
      status,
      progress,
      message,
      revision,
    }),
  );
  if (!root.result) return { ...root, analyses };
  return {
    ...root,
    analyses,
    result: {
      ...root.result,
      engine:
        parts.some((p) => p.engine === "drum") &&
        parts.some((p) => p.engine !== "drum")
          ? "mixed"
          : root.result.engine,
      parts,
      workspaceMix: documents.length > 1,
      analysis: {
        ...root.result.analysis,
        notes: parts.reduce((n, p) => n + p.notes.length, 0),
        warnings: [
          ...new Set(
            documents.flatMap((p) => p.result.analysis.warnings || []),
          ),
        ],
      },
    },
  };
}
