// The standalone workspace and the embedded Melodics feature share all controls.
let integrated =
  typeof window !== "undefined" &&
  window.location.pathname.startsWith("/instrument-lab/");
export const apiPath = (path) =>
  integrated ? path.replace(/^\/api(?=\/)/, "/api/instruments") : path;
export const enginePath = (file) =>
  `${integrated ? "/instrument-lab" : ""}/engine/${file}`;

export const workspacePath = integrated ? "/instrument-lab/" : "/";

export function configureLabPaths(inApp) {
  integrated = inApp;
}
