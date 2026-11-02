import type { Lesson } from "../../apps/desktop/src/renderer/types/lesson";
import type { FC, ReactNode } from "react";
declare const InstrumentLabEditor: FC<{
  initialProjectId?: string | null;
  embedded?: boolean;
  renderSourceEditor?: (props: {project: {id:string;sourceSongIds?:string[]}; projects: {id:string;sourceSongIds?:string[]}[]; onAudition:()=>void}) => ReactNode;
  onExit?: () => void;
  onStartLesson?: (lesson: Lesson) => void;
}>;
export default InstrumentLabEditor;
