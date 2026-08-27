// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectActivitySummary } from "../../shared/protocol";
import { WorkspaceRail, workspaceKey } from "./WorkspaceRail";

afterEach(cleanup);

describe("WorkspaceRail", () => {
  it("bails out of unrelated parent renders and updates selection and activity facts", () => {
    const workspaces = ["E:\\alpha", "E:\\beta"];
    const mapWorkspaces = vi.spyOn(workspaces, "map");
    const activity: ProjectActivitySummary = {
      projectId: "f25ee8d8-34f0-4c30-a045-b2a69f2e28bd",
      cwd: workspaces[0]!,
      busyConversationCount: 1,
      attentionConversationCount: 0,
    };
    const readBusyCount = vi.fn(() => 1);
    Object.defineProperty(activity, "busyConversationCount", {
      enumerable: true,
      get: readBusyCount,
    });
    const initialActivity = new Map([[workspaceKey(workspaces[0]!), activity]]);
    const unavailable = new Set<string>();

    function Harness() {
      const [, setUnrelated] = useState(0);
      const [activeCwd, setActiveCwd] = useState(workspaces[0]!);
      const [activityByWorkspace, setActivityByWorkspace] = useState<
        ReadonlyMap<string, ProjectActivitySummary>
      >(initialActivity);
      const onSelect = useCallback((cwd: string) => setActiveCwd(cwd), []);
      const onAdd = useCallback(() => undefined, []);
      return <>
        <button type="button" onClick={() => setUnrelated((value) => value + 1)}>
          unrelated
        </button>
        <button type="button" onClick={() => setActivityByWorkspace(new Map([[
          workspaceKey(workspaces[1]!),
          {
            projectId: "a11981c1-172f-4377-a082-3fb0f8c87519",
            cwd: workspaces[1]!,
            busyConversationCount: 0,
            attentionConversationCount: 2,
          },
        ]]))}>
          update activity
        </button>
        <WorkspaceRail
          workspaces={workspaces}
          activeCwd={activeCwd}
          unavailable={unavailable}
          activityByWorkspace={activityByWorkspace}
          activityCatalogTruncated={false}
          onSelect={onSelect}
          onAdd={onAdd}
        />
      </>;
    }

    render(<Harness />);
    const initialMaps = mapWorkspaces.mock.calls.length;
    const initialActivityReads = readBusyCount.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "unrelated" }));
    expect(mapWorkspaces).toHaveBeenCalledTimes(initialMaps);
    expect(readBusyCount).toHaveBeenCalledTimes(initialActivityReads);

    fireEvent.click(screen.getByRole("button", { name: "打开工作区 beta" }));
    expect(screen.getByRole("button", { name: "打开工作区 beta" }))
      .toHaveAttribute("aria-current", "true");

    fireEvent.click(screen.getByRole("button", { name: "update activity" }));
    expect(screen.getByRole("button", {
      name: "打开工作区 beta（2 个会话需要注意）",
    })).toBeInTheDocument();
  });
});
