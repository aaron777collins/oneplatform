import { useState } from "react";
import { FleetLayout } from "./components/layout/FleetLayout.js";
import type { FleetView } from "./components/layout/FleetSidebar.js";
import { ContainerListView } from "./components/containers/ContainerListView.js";
import { ImageListView } from "./components/images/ImageListView.js";
import { NetworkListView } from "./components/networks/NetworkListView.js";
import { VolumeListView } from "./components/volumes/VolumeListView.js";

export function App(): JSX.Element {
  const [view, setView] = useState<FleetView>("containers");

  return (
    <FleetLayout active={view} onSelect={setView}>
      {view === "containers" && <ContainerListView />}
      {view === "images" && <ImageListView />}
      {view === "networks" && <NetworkListView />}
      {view === "volumes" && <VolumeListView />}
    </FleetLayout>
  );
}
