// 7AVENUE: Clients → Projects navigation view.
//
// Self-contained custom feature (own file → minimal upstream merge cost).
//
// THE MODEL (important): this view lists the app's REAL projects (from
// /api/projects), grouped by client. The client is derived from each
// project's baseDir path (.../clients/<client>/<id>). This is NOT a folder
// browser — projects are real app records with real names and ids, so:
//   - clicking a project re-opens its design canvas by ID (no re-import)
//   - the real project name shows (not the on-disk UUID folder)
//   - new projects appear here automatically after creation
//
// "New client" creates an empty clients/<name>/ folder (+ design-system/).
// "New project" uses the native createProject flow (registers the client
// folder as a project location, then creates a project in it) → lands the
// user straight in the canvas. The on-disk folder is a UUID (native default);
// the readable name lives on the project record and is what we show.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { Project } from "../types";
import {
  listProjects,
  createProject,
  createFolder,
  ensureClientProjectLocation,
} from "../state/projects";

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

// derive the client name from a project's baseDir: .../clients/<client>/<...>
function clientFromBaseDir(baseDir: string | undefined, clientsRoot: string): string | null {
  if (!baseDir) return null;
  const root = clientsRoot.replace(/\/+$/, "") + "/";
  if (!baseDir.startsWith(root)) return null;
  const rest = baseDir.slice(root.length);
  const seg = rest.split("/")[0];
  return seg || null;
}

// strip the "<client> — " prefix we add at create time, for clean display
function displayName(project: Project, client: string): string {
  const prefix = `${client} — `;
  if (project.name?.startsWith(prefix)) return project.name.slice(prefix.length);
  return project.name || "Untitled";
}

interface ClientNode {
  name: string;
  path: string;
  projects: Project[];
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
  const [busy, setBusy] = useState(false);
  const [newProjectFor, setNewProjectFor] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");

  const clientsRoot = useMemo(
    () => (root ? `${root.replace(/\/+$/, "")}/clients` : ""),
    [root],
  );

  // Build the client list = every client folder on disk, each populated with
  // the REAL app projects whose baseDir lives under that client.
  const load = useCallback(async () => {
    if (!clientsRoot) { setClients([]); return; }
    setLoading(true);
    setError(null);
    try {
      const [clientDirs, allProjects] = await Promise.all([
        browseDir(clientsRoot),
        listProjects(),
      ]);
      const byClient = new Map<string, Project[]>();
      for (const p of allProjects) {
        const c = clientFromBaseDir(p.metadata?.baseDir, clientsRoot);
        if (!c) continue;
        if (!byClient.has(c)) byClient.set(c, []);
        byClient.get(c)!.push(p);
      }
      const nodes: ClientNode[] = clientDirs.map((c) => ({
        name: c.name,
        path: c.path,
        projects: (byClient.get(c.name) ?? []).sort(
          (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
        ),
      }));
      setClients(nodes);
      setExpanded((prev) =>
        Object.fromEntries(nodes.map((n) => [n.name, prev[n.name] ?? true])),
      );
    } catch (e: any) {
      setError(e?.message || "Failed to load clients");
    } finally {
      setLoading(false);
    }
  }, [clientsRoot]);

  useEffect(() => { void load(); }, [load]);

  // The entry views stay MOUNTED (just hidden) when you switch tabs, so the
  // mount effect above won't re-fire when you return to Clients. Reload
  // whenever this view becomes visible again (e.g. after designing a project
  // and clicking back to Clients) so newly-created projects always show.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void load();
        }
      },
      { threshold: 0.01 },
    );
    obs.observe(el);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { obs.disconnect(); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);

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
      try { await createFolder(clientPath, "design-system"); } catch { /* ok */ }
      await load();
      setExpanded((e) => ({ ...e, [name.trim()]: true }));
    } catch (e: any) {
      setError(e?.message || "Failed to create client");
    } finally {
      setBusy(false);
    }
  }, [clientsRoot, load]);

  // NEW project → native createProject inside the client's project location.
  // Lands the user straight in the design canvas.
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
        onProjectOpened?.(result.project.id); // → design canvas
      } catch (e: any) {
        setError(e?.message || "Failed to create project");
      } finally {
        setBusy(false);
      }
    },
    [newProjectName, onProjectOpened],
  );

  // OPEN an existing project → navigate by its project id (re-opens canvas).
  const openProject = useCallback(
    (project: Project) => {
      onProjectOpened?.(project.id);
    },
    [onProjectOpened],
  );

  return (
    <div className="clients-view" ref={rootRef}>
      <div className="clients-view__head">
        <div>
          <h1 className="clients-view__title">Clients</h1>
          <p className="clients-view__sub">
            Your client projects. Create a project under a client, then click it any time to keep designing.
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
                    key={project.id}
                    onClick={() => openProject(project)}
                  >
                    <Icon name="file-code" size={15} />
                    <span className="project-row__name">{displayName(project, client.name)}</span>
                    <span className="project-row__open">Open →</span>
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
