import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import {
  formatLineageValue,
  formatTransformSummary,
  formatTypeChange,
  kindLabel,
  type ColumnLineageOpenArgs,
  type ColumnLineageResult,
  type ColumnLineageStage,
} from "../lib/columnLineage";
import { runAfterPaint } from "../lib/prettyStruct";
import { Icon } from "./Icon";
import { useWinDrag } from "./ActivityShared";

type Props = {
  open: ColumnLineageOpenArgs | null;
  onClose: () => void;
  onHighlightNode?: (nodeId: string) => void;
};

const STAGE_W = 188;
const STAGE_H = 132;
const GAP = 36;
const PAD_X = 28;
const PAD_Y = 24;

function stageKindClass(kind: string): string {
  const k = (kind || "").toLowerCase();
  if (k === "source") return "source";
  if (k === "derived") return "derived";
  if (k === "sql") return "sql";
  return "pass";
}

export const ColumnLineageModal: React.FC<Props> = ({
  open,
  onClose,
  onHighlightNode,
}) => {
  const { pos, startDrag, dragging, settled, winRef } = useWinDrag({
    x: Math.max(24, Math.round((window.innerWidth - 760) / 2)),
    y: Math.max(48, Math.round((window.innerHeight - 560) / 2)),
  });
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ColumnLineageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Stage whose value chip was clicked — expands prior inputs. */
  const [focusValueId, setFocusValueId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setData(null);
      setError(null);
      setLoading(false);
      setActiveId(null);
      setFocusValueId(null);
      return;
    }
    setLoading(true);
    setData(null);
    setError(null);
    setActiveId(null);
    setFocusValueId(null);

    const ctrl = new AbortController();
    const cancelPaint = runAfterPaint(() => {
      if (!open.graph) {
        setData({
          available: false,
          column: open.column,
          stages: [],
          reason:
            "Lineage is only available for results from a NodeFlow run. Run a workflow and open lineage from its results grid.",
        });
        setLoading(false);
        return;
      }
      void api
        .columnLineage(open.graph, open.column, {
          node: open.nodeId,
          port: open.port,
          rowIndex: open.rowIndex,
          cellValue: open.cellValue,
          signal: ctrl.signal,
        })
        .then((res) => {
          if (ctrl.signal.aborted) return;
          setData(res);
          const stages = res.stages || [];
          if (stages.length) {
            const last = stages[stages.length - 1];
            setActiveId(last.id);
            if (last.value) setFocusValueId(last.id);
          }
        })
        .catch((e: any) => {
          if (ctrl.signal.aborted) return;
          if (e?.name === "AbortError") return;
          setError(String(e?.message || e));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    });

    return () => {
      cancelPaint();
      ctrl.abort();
    };
  }, [open]);

  const stages = useMemo(() => data?.stages || [], [data?.stages]);
  const hasValueHistory = stages.some((s) => s.value != null);
  const diagramW = Math.max(
    320,
    PAD_X * 2 + stages.length * STAGE_W + Math.max(0, stages.length - 1) * GAP,
  );
  const diagramH = PAD_Y * 2 + STAGE_H + 40;

  const connectors = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number; key: string }[] =
      [];
    for (let i = 0; i < stages.length - 1; i++) {
      const x1 = PAD_X + i * (STAGE_W + GAP) + STAGE_W;
      const x2 = PAD_X + (i + 1) * (STAGE_W + GAP);
      const y = PAD_Y + STAGE_H / 2;
      lines.push({ x1, y1: y, x2, y2: y, key: `c-${i}` });
    }
    return lines;
  }, [stages]);

  if (!open) return null;

  const clickStage = (stage: ColumnLineageStage) => {
    setActiveId(stage.id);
    if (stage.node_id) onHighlightNode?.(stage.node_id);
  };

  const focusStage =
    stages.find((s) => s.id === focusValueId) ||
    stages.find((s) => s.id === activeId) ||
    stages[stages.length - 1];

  return createPortal(
    <div
      ref={winRef as React.RefObject<HTMLDivElement>}
      className={
        "col-lineage-win win-float" +
        (dragging ? " dragging" : "") +
        (settled ? " settle" : "")
      }
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`Column lineage: ${open.column}`}
      data-testid="column-lineage-modal"
    >
      <div
        className="col-lineage-head"
        onMouseDown={startDrag}
        title="Drag to move"
      >
        <Icon.GitMerge size={14} />
        <span className="fx-title">
          Lineage · <code>{open.column}</code>
          {open.rowIndex != null ? (
            <span className="faint"> · row {open.rowIndex + 1}</span>
          ) : null}
        </span>
        <span className="spacer" />
        <button
          className="btn sm ghost"
          title="Close"
          data-testid="column-lineage-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          <Icon.X size={14} />
        </button>
      </div>
      <div className="col-lineage-body">
        {loading ? (
          <div className="faint col-lineage-empty" data-testid="column-lineage-loading">
            <span className="spin" /> Tracing column lineage…
          </div>
        ) : error ? (
          <div className="error-box" data-testid="column-lineage-error">
            {error}
          </div>
        ) : !data?.available ? (
          <div
            className="col-lineage-empty"
            data-testid="column-lineage-unavailable"
          >
            <div className="col-lineage-empty-title">Lineage unavailable</div>
            <p>
              {data?.reason ||
                "This result has no NodeFlow lineage to show."}
            </p>
          </div>
        ) : (
          <>
            {data.sql_flagged ? (
              <div className="col-lineage-note">
                Path crosses an opaque SQL / code node — upstream detail may be
                incomplete.
              </div>
            ) : null}
            <div
              className="col-lineage-diagram"
              data-testid="column-lineage-diagram"
              style={{ minHeight: diagramH + 8 }}
            >
              <svg
                className="col-lineage-svg"
                width={diagramW}
                height={diagramH}
                viewBox={`0 0 ${diagramW} ${diagramH}`}
                style={{ width: diagramW, height: diagramH }}
              >
                <defs>
                  <marker
                    id="col-lin-arrow"
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L7,3 L0,6 Z" fill="var(--text-faint)" />
                  </marker>
                </defs>
                {connectors.map((c) => (
                  <line
                    key={c.key}
                    x1={c.x1}
                    y1={c.y1}
                    x2={c.x2}
                    y2={c.y2}
                    className="col-lineage-edge"
                    markerEnd="url(#col-lin-arrow)"
                  />
                ))}
                {stages.map((stage, i) => {
                  const x = PAD_X + i * (STAGE_W + GAP);
                  const y = PAD_Y;
                  const active = activeId === stage.id;
                  return (
                    <g
                      key={stage.id}
                      className={
                        "col-lineage-node " +
                        stageKindClass(stage.kind) +
                        (active ? " active" : "")
                      }
                      data-testid="column-lineage-stage"
                      data-node-id={stage.node_id}
                      data-stage-kind={stage.kind}
                      transform={`translate(${x}, ${y})`}
                      onClick={() => clickStage(stage)}
                      style={{ cursor: stage.node_id ? "pointer" : "default" }}
                    >
                      <title>
                        {stage.node_label}
                        {stage.node_id ? ` · click to highlight` : ""}
                      </title>
                      <rect
                        width={STAGE_W}
                        height={STAGE_H}
                        rx={10}
                        ry={10}
                        className="col-lineage-card"
                      />
                      <text
                        x={12}
                        y={22}
                        className="col-lineage-kicker"
                      >
                        {kindLabel(stage.kind)} · {stage.node_type}
                      </text>
                      <text
                        x={12}
                        y={44}
                        className="col-lineage-col"
                      >
                        {stage.column.length > 18
                          ? stage.column.slice(0, 17) + "…"
                          : stage.column}
                      </text>
                      <text
                        x={12}
                        y={64}
                        className="col-lineage-label"
                      >
                        {(stage.node_label || stage.node_type).length > 20
                          ? (stage.node_label || stage.node_type).slice(0, 19) +
                            "…"
                          : stage.node_label || stage.node_type}
                      </text>
                      <foreignObject x={8} y={74} width={STAGE_W - 16} height={52}>
                        <div
                          className="col-lineage-change-mini"
                          data-testid="column-lineage-transform-mini"
                        >
                          {formatTransformSummary(
                            stage.change,
                            stage.column,
                          )}
                        </div>
                      </foreignObject>
                    </g>
                  );
                })}
              </svg>
            </div>

            {hasValueHistory ? (
              <div
                className="col-lineage-values"
                data-testid="column-lineage-values"
              >
                <div className="col-lineage-values-head">
                  <span className="col-lineage-values-title">Value history</span>
                  <span className="faint">
                    Click a value to see prior inputs at that step
                  </span>
                </div>
                <ol className="col-lineage-value-timeline">
                  {stages.map((stage, i) => {
                    const vv = stage.value;
                    const focused = focusValueId === stage.id;
                    return (
                      <li
                        key={stage.id}
                        className={
                          "col-lineage-value-step" + (focused ? " focus" : "")
                        }
                        data-testid="column-lineage-value-step"
                      >
                        <div className="col-lineage-value-rail">
                          <span className="col-lineage-value-dot" />
                          {i < stages.length - 1 ? (
                            <span className="col-lineage-value-line" />
                          ) : null}
                        </div>
                        <div className="col-lineage-value-body">
                          <div className="col-lineage-value-meta">
                            <span className={"pill " + stageKindClass(stage.kind)}>
                              {kindLabel(stage.kind)}
                            </span>
                            <code>{stage.column}</code>
                            <span className="faint">
                              {stage.node_label || stage.node_type}
                            </span>
                          </div>
                          {vv?.available ? (
                            <button
                              type="button"
                              className={
                                "col-lineage-value-chip" +
                                (focused ? " on" : "")
                              }
                              data-testid="column-lineage-value-chip"
                              title="Show how this value was derived"
                              onClick={() => {
                                setFocusValueId(stage.id);
                                setActiveId(stage.id);
                                if (stage.node_id) {
                                  onHighlightNode?.(stage.node_id);
                                }
                              }}
                            >
                              {formatLineageValue(vv.value)}
                            </button>
                          ) : (
                            <span
                              className="col-lineage-value-missing"
                              data-testid="column-lineage-value-missing"
                            >
                              value unavailable
                            </span>
                          )}
                          {vv?.expression ? (
                            <code className="col-lineage-value-expr">
                              {vv.expression}
                            </code>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {focusStage?.value ? (
                  <div
                    className="col-lineage-value-prior"
                    data-testid="column-lineage-value-prior"
                  >
                    <div className="col-lineage-value-prior-head">
                      Prior values for{" "}
                      <code>{focusStage.column}</code>
                      {focusStage.value.available ? (
                        <>
                          {" "}
                          ={" "}
                          <strong>
                            {formatLineageValue(focusStage.value.value)}
                          </strong>
                        </>
                      ) : null}
                    </div>
                    {focusStage.value.inputs &&
                    focusStage.value.inputs.length > 0 ? (
                      <ul className="col-lineage-value-inputs">
                        {focusStage.value.inputs.map((inp) => (
                          <li key={inp.column}>
                            <code>{inp.column}</code>
                            <span className="col-lineage-io-arrow">→</span>
                            {inp.available ? (
                              <strong>
                                {formatLineageValue(inp.value)}
                              </strong>
                            ) : (
                              <span className="faint">unavailable</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="faint">
                        {focusStage.value.available
                          ? "No upstream input columns at this step."
                          : focusStage.value.reason ||
                            "Could not resolve a sample for this step."}
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="col-lineage-detail" data-testid="column-lineage-detail">
              {(() => {
                const stage =
                  stages.find((s) => s.id === activeId) ||
                  stages[stages.length - 1];
                if (!stage) return null;
                const ch = stage.change || { summary: "" };
                return (
                  <>
                    <div className="col-lineage-detail-head">
                      <span className={"pill " + stageKindClass(stage.kind)}>
                        {kindLabel(stage.kind)}
                      </span>
                      <strong>{stage.column}</strong>
                      <span className="faint">
                        via {stage.node_label || stage.node_type}
                      </span>
                      {stage.node_id ? (
                        <button
                          type="button"
                          className="btn sm ghost"
                          data-testid="column-lineage-highlight"
                          onClick={() => onHighlightNode?.(stage.node_id)}
                        >
                          Highlight node
                        </button>
                      ) : null}
                    </div>
                    <div
                      className="col-lineage-io col-lineage-io-transform"
                      data-testid="column-lineage-transform"
                    >
                      <div>
                        <div className="col-lineage-io-label">Input</div>
                        <div className="col-lineage-io-val">
                          {ch.inputs && ch.inputs.length
                            ? ch.inputs.join(", ")
                            : "—"}
                        </div>
                      </div>
                      <div className="col-lineage-io-arrow">→</div>
                      <div>
                        <div className="col-lineage-io-label">Op</div>
                        <div
                          className="col-lineage-io-val"
                          data-testid="column-lineage-op"
                        >
                          {(ch.expression || ch.op || ch.summary || "—").trim() ||
                            "—"}
                        </div>
                      </div>
                      <div className="col-lineage-io-arrow">→</div>
                      <div>
                        <div className="col-lineage-io-label">Output</div>
                        <div className="col-lineage-io-val">
                          {ch.output || stage.column}
                        </div>
                      </div>
                    </div>
                    <p
                      className="col-lineage-transform-line"
                      data-testid="column-lineage-transform-line"
                    >
                      {formatTransformSummary(ch, stage.column)}
                    </p>
                    <p className="col-lineage-summary">
                      {ch.unchanged ? (
                        <span className="pill pass">Unchanged</span>
                      ) : (
                        <span className="pill derived">Changed</span>
                      )}{" "}
                      {ch.summary}
                    </p>
                    {formatTypeChange(ch) ? (
                      <p
                        className="col-lineage-detail-text"
                        data-testid="column-lineage-type-change"
                      >
                        Type: <code>{formatTypeChange(ch)}</code>
                      </p>
                    ) : null}
                    {ch.group_by && ch.group_by.length > 0 ? (
                      <p
                        className="col-lineage-detail-text"
                        data-testid="column-lineage-group-by"
                      >
                        Group by:{" "}
                        <code>{ch.group_by.join(", ")}</code>
                      </p>
                    ) : null}
                    {ch.join_how ? (
                      <p
                        className="col-lineage-detail-text"
                        data-testid="column-lineage-join-how"
                      >
                        Join: <code>{ch.join_how}</code>
                        {ch.predicate ? (
                          <>
                            {" "}
                            on <code>{ch.predicate}</code>
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    {ch.detail ? (
                      <p className="col-lineage-detail-text">{ch.detail}</p>
                    ) : null}
                    {ch.expression ? (
                      <pre className="col-lineage-expr">{ch.expression}</pre>
                    ) : null}
                    {ch.mapping ? (
                      <p className="col-lineage-detail-text">
                        Mapping: <code>{ch.mapping.from}</code> →{" "}
                        <code>{ch.mapping.to}</code>
                      </p>
                    ) : null}
                    {ch.predicate && !ch.join_how ? (
                      <p
                        className="col-lineage-detail-text"
                        data-testid="column-lineage-predicate"
                      >
                        Predicate: <code>{ch.predicate}</code>
                      </p>
                    ) : null}
                  </>
                );
              })()}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
