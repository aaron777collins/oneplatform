export type FleetView = "containers" | "images" | "networks" | "volumes";

const NAV: { id: FleetView; label: string; icon: string }[] = [
  { id: "containers", label: "Containers", icon: "▣" },
  { id: "images", label: "Images", icon: "◳" },
  { id: "networks", label: "Networks", icon: "⇄" },
  { id: "volumes", label: "Volumes", icon: "▤" },
];

interface FleetSidebarProps {
  active: FleetView;
  onSelect: (view: FleetView) => void;
}

export function FleetSidebar({ active, onSelect }: FleetSidebarProps): JSX.Element {
  return (
    <nav className="fleet-sidebar">
      <h1>Docker Fleet</h1>
      {NAV.map((item) => (
        <button
          key={item.id}
          className={`fleet-nav-item ${active === item.id ? "active" : ""}`}
          onClick={() => onSelect(item.id)}
        >
          <span aria-hidden>{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
