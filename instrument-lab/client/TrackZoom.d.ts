import type { FC } from "react";
declare const TrackZoom: FC<{
  view: [number, number];
  duration: number;
  focus: number;
  minSpan?: number;
  onView: (view: [number, number]) => void;
}>;
export default TrackZoom;
