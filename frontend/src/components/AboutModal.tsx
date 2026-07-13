// .538: Settings -> About. The version/build moved here from the top
// bar, joined by everything an about page should say: runtime, engines,
// and each optional package with its installed version.
import React, { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { api } from "../lib/api";

interface AboutInfo {
  version: string;
  build: string;
  python: string;
  platform: string;
  engines: { duckdb: string; sqlite: string };
  frontend: string;
  packages: {
    name: string;
    version: string | null;
    installed: boolean;
    role: string;
  }[];
}

export const AboutModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .about()
      .then((d) => live && setInfo(d as AboutInfo))
      .catch((e) => live && setErr(e?.message || "Could not load"));
    return () => {
      live = false;
    };
  }, []);

  const copyAll = () => {
    if (!info) return;
    const lines = [
      `SamQL v${info.version} · build ${info.build}`,
      `Python ${info.python} · ${info.platform}`,
      `DuckDB ${info.engines.duckdb} · SQLite ${info.engines.sqlite}`,
      ...info.packages.map(
        (p) => `${p.name}: ${p.installed ? p.version : "not installed"}`,
      ),
    ];
    try {
      void navigator.clipboard?.writeText(lines.join("\n"));
    } catch {
      /* ignore */
    }
  };

  return (
    <Modal title="About SamQL" onClose={onClose}>
      <div className="about-body">
        <div className="about-head">
          <img
            src="/logo.png"
            alt=""
            className="about-mark"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          <div>
            <div className="about-name">
              Sam<span className="ql">QL</span>
            </div>
            {info && (
              <div
                className="about-ver"
                data-version={info.version}
                data-build={info.build}
              >
                <span data-testid="about-version">v{info.version}</span>
                {" · "}
                <span data-testid="about-build">build {info.build}</span>
              </div>
            )}
          </div>
        </div>
        {err && <div className="about-err">{err}</div>}
        {info && (
          <>
            <div className="about-sec">Runtime</div>
            <div className="about-row">
              <span>Python</span>
              <span>{info.python}</span>
            </div>
            <div className="about-row">
              <span>Platform</span>
              <span>{info.platform}</span>
            </div>
            <div className="about-row">
              <span>Frontend</span>
              <span>{info.frontend}</span>
            </div>
            <div className="about-sec">Engines</div>
            <div className="about-row">
              <span>DuckDB</span>
              <span>{info.engines.duckdb}</span>
            </div>
            <div className="about-row">
              <span>SQLite</span>
              <span>{info.engines.sqlite}</span>
            </div>
            <div className="about-sec">Packages</div>
            {info.packages.map((p) => (
              <div
                className="about-row"
                key={p.name}
                title={p.role}
                data-testid={`about-package-${p.name}`}
                data-installed={p.installed ? "true" : "false"}
              >
                <span>
                  {p.name}
                  <span
                    className={
                      "about-pkg-status" + (p.installed ? " on" : " off")
                    }
                  >
                    {p.installed ? "active" : "inactive"}
                  </span>
                </span>
                <span className={p.installed ? "" : "faint"}>
                  {p.installed ? p.version : "not installed"}
                </span>
              </div>
            ))}
            <div className="about-actions">
              <button className="btn sm ghost" onClick={copyAll}>
                Copy info
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
