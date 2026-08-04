import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { SWRConfig } from "swr";
import { Toaster } from "sonner";
import { App } from "@/web/app";
import { swrFetcher } from "@/web/api";
import "@/web/styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SWRConfig value={{ fetcher: swrFetcher, revalidateOnFocus: true, dedupingInterval: 1_000 }}>
      <BrowserRouter>
        <App />
        <Toaster
          position="top-right"
          toastOptions={{
            style: { background: "#f8fafc", color: "#0f172a", borderColor: "rgb(15 23 42 / 0.14)" },
          }}
        />
      </BrowserRouter>
    </SWRConfig>
  </React.StrictMode>,
);
