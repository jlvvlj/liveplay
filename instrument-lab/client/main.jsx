import React from "react";
import { createRoot } from "react-dom/client";
import InstrumentLabEditor from "./InstrumentLabEditor.jsx";
import "../../apps/desktop/src/renderer/styles/tokens.css";
import "./standalone.css";

createRoot(document.getElementById("root")).render(<InstrumentLabEditor />);
