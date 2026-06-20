// 7AVENUE: Clients → Projects navigation view.
//
// Self-contained custom feature (kept in its own file to minimise upstream
// merge cost). Reads the cloned monorepo folder tree on disk via the
// /api/browse/dir daemon endpoint:
//
//   <monorepo>/clients/<client>/<project>/
//
// and presents clients with their projects nested. Clicking a project opens
// it folder-backed via the existing /api/import/folder endpoint.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";
import { importFolderProject } from "../state/projects";

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
      if (clientDirs.length === 0) {
        setError(`No clients found under ${clientsRoot}. Make sure you've cloned the 7avenue-design-projects monorepo and pointed to its folder.`);
        setClients([]);
        return;
      }
      const nodes: ClientNode[] = await Promise.all(
        clientDirs.map(async (c) => ({
          name: c.name,
          path: c.path,
          // a client's children are projects (skip design-system / _shared)
          projects: (await browseDir(c.path)).filter(
            (p) => p.name !== "design-system",
          ),
        })),
      );
      setClients(nodes);
      // auto-expand all clients on first load
      setExpanded(Object.fromEntries(nodes.map((n) => [n.name, true])));
    } catch (e: any) {
      setError(e?.message || "Failed to read clients folder");
    } finally {
      setLoading(false);
    }
  }, [clientsRoot]);

  useEffect(() => { void load(); }, [load]);

  const pickFolder = useCallback(async () => {
    // use the daemon's native folder picker (same one the import flow uses)
    try {
      const resp = await fetch("/api/dialog/open-folder", { method: "POST" });
      const body = (await resp.json()) as { path?: string | null };
      if (body.path) {
        setRoot(body.path);
        try { localStorage.setItem(MONOREPO_KEY, body.path); } catch { /* ignore */ }
      }
    } catch {
      /* dialog unavailable */
    }
  }, []);

  const openProject = useCallback(
    async (clientName: string, project: DirEntry) => {
      setOpening(project.path);
      try {
        const result = await importFolderProject({
          baseDir: project.path,
          name: `${clientName} — ${project.name}`,
        });
        onProjectOpened?.(result.project.id);
      } catch (e: any) {
        setError(e?.message || "Failed to open project");
      } finally {
        setOpening(null);
      }
    },
    [onProjectOpened],
  );

  return (
    <div className="clients-view">
      <div className="clients-view__head">
        <div>
          <h1 className="clients-view__title">Clients</h1>
          <p className="clients-view__sub">
            Your client projects from the 7AVENUE design monorepo. Click a project to open it.
          </p>
        </div>
        <div className="clients-view__head-actions">
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
                {client.projects.length === 0 ? (
                  <div className="client__no-projects">No projects yet</div>
                ) : (
                  client.projects.map((project) => (
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
                  ))
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
