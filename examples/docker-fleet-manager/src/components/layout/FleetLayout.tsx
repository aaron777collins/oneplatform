import type { ReactNode } from "react";
import { FleetSidebar, type FleetView } from "./FleetSidebar.js";

interface FleetLayoutProps {
  active: FleetView;
  onSelect: (view: FleetView) => void;
  children: ReactNode;
}

export function FleetLayout({ active, onSelect, children }: FleetLayoutProps): JSX.Element {
  return (
    <div className="fleet-layout">
      <FleetSidebar active={active} onSelect={onSelect} />
      <main className="fleet-content">{children}</main>
    </div>
  );
}
