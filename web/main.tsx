import React from "react";
import { createRoot } from "react-dom/client";
import Admin from "./Admin";
import Widget from "./Widget";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  location.pathname === "/widget" ? <Widget /> : <Admin />,
);
