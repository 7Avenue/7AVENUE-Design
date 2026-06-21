// 7AVENUE: Clients → Projects navigation view.
//
// Self-contained custom feature (own file → minimal upstream merge cost).
// Reads the cloned monorepo folder tree on disk via /api/browse/dir:
//
//   <monorepo>/clients/<client>/<project>/
//
// - Lists clients with their projects nested.
// - "New client" creates clients/<name>/ (+ a design-system/ folder).
// - "New project" registers the client folder as a native "project location"
//   then uses the REAL createProject flow → the project is made inside the
//   client folder and the user lands straight in the design canvas (native
//   experience, no folder picker). Project syncs with the team via Git.
// - Opening an EXISTING project folder (with files) imports it via the
//   sanctioned host bridge (PR#974 security model — no upstream edits).
import { useCallback, useEffect, useMemo, useState } from "react";
import { isOpenDesignHostAvailable, pickAndImportHostProject } from "@open-design/host";
import { Icon } from "./Icon";
import { importFolderProject, createFolder, createProject, ensureClientProjectLocation } from "../state/projects";

const MONOREPO_KEY = "7av-monorepo-root";

interface DirEntry {
  name: string;
  path: string;
}

async function browseDir(path: string): Promise<DirEntry[]> {
  const resp = await fetch(`/api/browse/dir?path=${encodeURIComponent(path)}`);
  if (!resp.ok) return [];
  const body = (await resp.json()) as { entries?: DirEntry[] };
  return body.entries ?? [];
}

interface ClientNode {
  name: string;
  path: string;
  projects: DirEntry[];
}

export interface ClientsViewProps {
  onProjectOpened?: (projectId: string) => void;
}

export function ClientsView({ onProjectOpened }: ClientsViewProps) {
  const [root, setRoot] = useState<string>(() => {
    try { return localStorage.getItem(MONOREPO_KEY) ?? ""; } catch { return ""; }
  });
  const [clients, setClients] = useState<ClientNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // inline "new project" input state, keyed by client name
  const [newProjectFor, setNewProjectFor] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");

  const clientsRoot = useMemo(
    () => (root ? `${root.replace(/\/+$/, "")}/clients` : ""),
    [root],
  );

  const load = useCallback(async () => {
    if (!clientsRoot) { setClients([]); return; }
    setLoading(true);
    setError(null);
    try {
      const clientDirs = await browseDir(clientsRoot);
      const nodes: ClientNode[] = await Promise.all(
        clientDirs.map(async (c) => ({
          name: c.name,
          path: c.path,
          projects: (await browseDir(c.path)).filter(
            (p) => p.name !== "design-system",
          ),
        })),
      );
      setClients(nodes);
      setExpanded((prev) =>
        Object.fromEntries(nodes.map((n) => [n.name, prev[n.name] ?? true])),
      );
    } catch (e: any) {
      setError(e?.message || "Failed to read clients folder");
    } finally {
      setLoading(false);
    }
  }, [clientsRoot]);

  useEffect(() => { void load(); }, [load]);

  const pickFolder = useCallback(async () => {
    try {
      const resp = await fetch("/api/dialog/open-folder", { method: "POST" });
      const body = (await resp.json()) as { path?: string | null };
      if (body.path) {
        setRoot(body.path);
        try { localStorage.setItem(MONOREPO_KEY, body.path); } catch { /* ignore */ }
      }
    } catch { /* dialog unavailable */ }
  }, []);

  const addClient = useCallback(async () => {
    if (!clientsRoot) { setError("Set the monorepo folder first."); return; }
    const name = window.prompt("New client name (e.g. yousicplay)");
    if (!name?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const clientPath = await createFolder(clientsRoot, name.trim());
      // seed an (empty) design-system folder so each client has one
      try { await createFolder(clientPath, "design-system"); } catch { /* ok */ }
      await load();
      setExpanded((e) => ({ ...e, [name.trim()]: true }));
    } catch (e: any) {
      setError(e?.message || "Failed to create client");
    } finally {
      setBusy(false);
    }
  }, [clientsRoot, load]);

  const hostAvailable = isOpenDesignHostAvailable();

  // NEW project under a client → use the REAL native createProject flow.
  // We register the client folder as a "project location", then createProject
  // with that locationId — the daemon makes the project INSIDE the client
  // folder and the app drops the user straight into the design canvas (no
  // folder picker, no import). This is the genuine native experience, and the
  // project lands in the monorepo so it syncs with the team via Git.
  const handleCreateProject = useCallback(
    async (client: ClientNode) => {
      const name = newProjectName.trim();
      if (!name) return;
      setBusy(true);
      setError(null);
      try {
        const locationId = await ensureClientProjectLocation(client.name, client.path);
        const result = await createProject({
          name: `${client.name} — ${name}`,
          projectLocationId: locationId,
          skillId: null,
          designSystemId: null,
        });
        setNewProjectFor(null);
        setNewProjectName("");
        void load();
        onProjectOpened?.(result.project.id); // navigates into the canvas
      } catch (e: any) {
        setError(e?.message || "Failed to create project");
      } finally {
        setBusy(false);
      }
    },
    [newProjectName, load, onProjectOpened],
  );

  // OPEN an EXISTING project folder (one that already has design files, e.g.
  // Lydi). These pre-existing folders must be imported. On desktop the app's
  // security model (PR #974) requires the native folder picker to mint the
  // import token; we use the sanctioned host bridge. (New projects above never
  // hit this path.) Browser-dev fallback: direct by-path import.
  const openProject = useCallback(
    async (clientName: string, project: DirEntry) => {
      setOpening(project.path);
      setError(null);
      try {
        const label = `${clientName} — ${project.name}`;
        if (hostAvailable) {
          const result = await pickAndImportHostProject({ name: label });
          if (result && "ok" in result && result.ok === true) {
            onProjectOpened?.(result.projectId);
          } else if (result && "canceled" in result && result.canceled) {
            /* canceled */
          } else {
            throw new Error((result as any)?.reason || `Pick the project folder: ${project.path}`);
          }
        } else {
          const result = await importFolderProject({ baseDir: project.path, name: label });
          onProjectOpened?.(result.project.id);
        }
      } catch (e: any) {
        setError(e?.message || "Failed to open project");
      } finally {
        setOpening(null);
      }
    },
    [hostAvailable, onProjectOpened],
  );

  return (
    <div className="clients-view">
      <div className="clients-view__head">
        <div>
          <h1 className="clients-view__title">Clients</h1>
          <p className="clients-view__sub">
            Your client projects from the 7AVENUE design monorepo. Create a project under a client to start designing.
          </p>
        </div>
        <div className="clients-view__head-actions">
          {root ? (
            <button className="clients-view__btn clients-view__btn--accent" onClick={addClient} disabled={busy}>
              <Icon name="plus" size={15} />
              New client
            </button>
          ) : null}
          <button className="clients-view__btn" onClick={pickFolder}>
            <Icon name="folder" size={15} />
            {root ? "Change folder" : "Set monorepo folder"}
          </button>
          {root ? (
            <button className="clients-view__btn clients-view__btn--ghost" onClick={() => void load()} disabled={loading}>
              <Icon name="refresh" size={15} />
              {loading ? "Loading…" : "Refresh"}
            </button>
          ) : null}
        </div>
      </div>

      {root ? (
        <div className="clients-view__root-path">{clientsRoot}</div>
      ) : (
        <div className="clients-view__empty">
          <p>No monorepo folder set yet.</p>
          <p className="clients-view__empty-sub">
            Clone <code>github.com/7Avenue/7avenue-design-projects</code>, then click
            <b> Set monorepo folder</b> and choose it. Clients and their projects appear here.
          </p>
        </div>
      )}

      {error ? <div className="clients-view__error">{error}</div> : null}

      <div className="clients-list">
        {clients.map((client) => (
          <div className="client" key={client.name}>
            <button
              className="client__header"
              onClick={() =>
                setExpanded((e) => ({ ...e, [client.name]: !e[client.name] }))
              }
            >
              <Icon name={expanded[client.name] ? "chevron-down" : "chevron-right"} size={16} />
              <span className="client__name">{client.name}</span>
              <span className="client__count">{client.projects.length}</span>
            </button>
            {expanded[client.name] ? (
              <div className="client__projects">
                {client.projects.map((project) => (
                  <button
                    className="project-row"
                    key={project.path}
                    onClick={() => void openProject(client.name, project)}
                    disabled={opening === project.path}
                  >
                    <Icon name="file-code" size={15} />
                    <span className="project-row__name">{project.name}</span>
                    <span className="project-row__open">
                      {opening === project.path ? "Opening…" : "Open →"}
                    </span>
                  </button>
                ))}

                {newProjectFor === client.name ? (
                  <div className="new-project-row">
                    <Icon name="plus" size={15} />
                    <input
                      className="new-project-row__input"
                      autoFocus
                      placeholder="Project name…"
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleCreateProject(client);
                        if (e.key === "Escape") { setNewProjectFor(null); setNewProjectName(""); }
                      }}
                      disabled={busy}
                    />
                    <button
                      className="new-project-row__create"
                      onClick={() => void handleCreateProject(client)}
                      disabled={busy || !newProjectName.trim()}
                    >
                      {busy ? "Creating…" : "Create"}
                    </button>
                  </div>
                ) : (
                  <button
                    className="new-project-btn"
                    onClick={() => { setNewProjectFor(client.name); setNewProjectName(""); }}
                  >
                    <Icon name="plus" size={15} />
                    New project
                  </button>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
