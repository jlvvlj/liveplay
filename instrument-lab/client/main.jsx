import React from "react";
import { createRoot } from "react-dom/client";
import InstrumentLabEditor from "./InstrumentLabEditor.jsx";
import "./standalone.css";

createRoot(document.getElementById("root")).render(<InstrumentLabEditor />);
