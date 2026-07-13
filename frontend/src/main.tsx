import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// .468: the LAST LINE OF DEFENSE. A render-phase exception anywhere in
// the tree used to unmount everything -- one hook-order slip in the
// Field Explorer turned the whole app into a blank window. Any such
// error now lands on a card that names it, keeps the black screen
// away, and offers a reload. (The specific crash is fixed too; this
// boundary is for whatever tries it next.)
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("SamQL render error:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#15171b",
            color: "#e8eaef",
            fontFamily: "system-ui, Segoe UI, Roboto, sans-serif",
          }}
        >
          <div style={{ maxWidth: 640, padding: 32 }}>
            <h1 style={{ color: "#54b949", margin: "0 0 8px", fontSize: 24 }}>
              SamQL hit a rendering error
            </h1>
            <p style={{ color: "#9aa3b2", margin: "0 0 12px" }}>
              The view crashed while drawing. Your data and server are
              untouched — reloading brings everything back.
            </p>
            <pre
              style={{
                background: "#1b1e23",
                border: "1px solid #2b2f37",
                borderRadius: 8,
                padding: 12,
                fontSize: 12,
                whiteSpace: "pre-wrap",
                color: "#e5614b",
              }}
            >
              {String(this.state.error?.message || this.state.error)}
            </pre>
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: 12,
                padding: "8px 16px",
                borderRadius: 8,
                border: "1px solid #3a404b",
                background: "#23272f",
                color: "#e8eaef",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Reload SamQL
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
