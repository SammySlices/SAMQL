import React from "react";

interface NodeFlowStatusBarProps {
  kind: string;
  text: string;
  running: boolean;
  nodeCount: number;
  edgeCount: number;
}

export const NodeFlowStatusBar = React.memo(function NodeFlowStatusBar({
  kind,
  text,
  running,
  nodeCount,
  edgeCount,
}: NodeFlowStatusBarProps) {
  return (
    <div className={"nb2-statusbar " + kind}>
      <span className={"nb2-status-dot " + kind} />
      <span className="nb2-status-text">
        {running && <span className="spin" />} {text}
      </span>
      <span className="nb2-status-right">
        {nodeCount} node{nodeCount === 1 ? "" : "s"} · {edgeCount} wire
        {edgeCount === 1 ? "" : "s"}
      </span>
    </div>
  );
});
