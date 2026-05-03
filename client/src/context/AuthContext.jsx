import { createContext, useContext, useState, useEffect } from "react";
const Ctx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [firm, setFirm] = useState(null);
  const [loading, setLoading] = useState(true);

  const apiFetch = (path, opts = {}) => {
    const token = localStorage.getItem("token");
    return fetch(path, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      },
    });
  };

  const loadMe = async () => {
    const token = localStorage.getItem("token");
    if (!token) { setLoading(false); return; }
    try {
      const r = await apiFetch("/api/auth/me");
      const d = await r.json();
      if (d.user) { setUser(d.user); setFirm(d.firm || null); }
      else localStorage.removeItem("token");
    } catch { localStorage.removeItem("token"); }
    setLoading(false);
  };

  useEffect(() => { loadMe(); }, []);

  const login = async (email, password) => {
    const r = await apiFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    localStorage.setItem("token", d.token);
    setUser(d.user);
    return d.user;
  };

  const register = async (email, password, name, ref) => {
    const r = await apiFetch("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, name, ref }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    localStorage.setItem("token", d.token);
    setUser(d.user);
    return d.user;
  };

  const logout = () => { localStorage.removeItem("token"); setUser(null); setFirm(null); };
  const refreshUser = () => loadMe();

  return <Ctx.Provider value={{ user, firm, loading, login, register, logout, refreshUser, apiFetch }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
