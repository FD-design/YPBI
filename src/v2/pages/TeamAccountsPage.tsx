import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, KeyRound, Plus, RefreshCw, Search, Shield, UserCheck, UserX, X } from 'lucide-react';
import type { TeamAccount } from '../../../contracts/team-accounts';
import { useAuthentication } from '../app/AuthProvider';
import { teamRequest, teamListSchema, teamWriteSchema } from '../api/team-accounts';
import { StatePanel } from '../components/StatePanel';
import { useBodyScrollLock } from '../../components/layout/useBodyScrollLock';
import './team-accounts.css';

type Editor = { action: 'create' } | { action: 'role' | 'status' | 'password'; user: TeamAccount };
const roleName = (role: string) => role === 'maintainer' ? '管理员' : '普通账号';

export function TeamAccountsPage() {
  const { state } = useAuthentication();
  if (state.status !== 'authenticated' || state.session.user.role !== 'maintainer') return <div className="v2-page"><StatePanel kind="forbidden" title="无权访问账号管理" description="仅管理员可以管理团队账号。" /></div>;
  return <TeamAccounts userId={state.session.user.subjectId} csrfToken={state.session.csrfToken} />;
}

function TeamAccounts({ userId, csrfToken }: { userId: string; csrfToken: string }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<{ items: TeamAccount[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let active = true;
    setLoading(true); setError(''); setData(null);
    teamRequest(`?${new URLSearchParams({ search: filter, page: String(page) })}`, teamListSchema, { signal: controller.signal })
      .then(result => { if (active) setData(result.data); })
      .catch(() => { if (active) setError('账号列表加载失败，请重试'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [filter, page, revision]);
  return <div className="v2-page team-accounts">
    <header className="v2-page-head"><div><span className="v2-eyebrow">团队与权限</span><h1>账号管理</h1></div>
      <button className="team-primary" onClick={() => { setNotice(''); setEditor({ action: 'create' }); }}><Plus size={16}/>创建账号</button>
    </header>
    <div className="team-toolbar"><form onSubmit={event => { event.preventDefault(); setFilter(search.trim()); setPage(1); }}>
      <Search size={16} aria-hidden="true"/><input aria-label="搜索账号或姓名" placeholder="搜索账号或姓名" value={search} maxLength={128} onChange={event => setSearch(event.target.value)}/><button type="submit">搜索</button>
    </form><button title="刷新列表" aria-label="刷新列表" className="team-icon" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={17}/></button></div>
    {notice && <p className="team-notice" role="status">{notice}</p>}
    {error && <div className="team-error" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>重新加载</button></div>}
    <div className="team-table" aria-busy={loading}><table><thead><tr><th>账号 / 姓名</th><th>权限</th><th>状态</th><th>数据范围</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>{loading ? <tr><td colSpan={6}>正在加载账号…</td></tr> : !data?.items.length ? <tr><td colSpan={6}>{error ? '暂无可显示结果' : '没有符合条件的账号'}</td></tr> : data.items.map(user => <tr key={user.id}>
        <td><b>{user.username}</b>{user.id === userId && <span className="team-self">当前账号</span>}<small>{user.displayName || '未设置姓名'}</small></td>
        <td><span className={`team-role ${user.role === 'maintainer' ? 'is-admin' : ''}`}>{roleName(user.role)}</span></td>
        <td><span className={user.status === 'active' ? 'team-active' : 'team-disabled'}>{user.status === 'active' ? '正常' : '已停用'}</span>{user.mustChangePassword && <small>首次登录须改密</small>}</td>
        <td>全部平台</td><td>{new Date(user.createdAt).toLocaleDateString('zh-CN')}</td>
        <td><div className="team-actions"><button disabled={user.id === userId} onClick={() => setEditor({ action: 'role', user })}><Shield size={14}/>权限</button><button disabled={user.id === userId} onClick={() => setEditor({ action: 'password', user })}><KeyRound size={14}/>重置密码</button><button disabled={user.id === userId} onClick={() => setEditor({ action: 'status', user })}>{user.status === 'active' ? <UserX size={14}/> : <UserCheck size={14}/>} {user.status === 'active' ? '停用' : '启用'}</button></div></td>
      </tr>)}</tbody></table></div>
    <footer className="team-pagination"><span>共 {data?.total ?? 0} 个账号 · 第 {page} 页</span><button title="上一页" aria-label="上一页" disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)}><ChevronLeft size={18}/></button><button title="下一页" aria-label="下一页" disabled={loading || page * 20 >= (data?.total ?? 0)} onClick={() => setPage(value => value + 1)}><ChevronRight size={18}/></button></footer>
    {editor && <AccountEditor editor={editor} csrfToken={csrfToken} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setNotice('账号已保存，权限及密码变更后需重新登录。'); setRevision(value => value + 1); }}/>}
  </div>;
}

function AccountEditor({ editor, csrfToken, onClose, onSaved }: { editor: Editor; csrfToken: string; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(editor.action === 'create' ? 'reader' : editor.user.role === 'maintainer' ? 'maintainer' : 'reader');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useBodyScrollLock(true);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  const title = editor.action === 'create' ? '创建账号' : editor.action === 'role' ? '调整权限' : editor.action === 'password' ? '重置密码' : editor.user.status === 'active' ? '停用账号' : '启用账号';
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    const payload = editor.action === 'create' ? { username: username.trim(), ...(displayName.trim() ? { displayName: displayName.trim() } : {}), password, role }
      : editor.action === 'role' ? { action: 'role', role }
      : editor.action === 'password' ? { action: 'password', password }
      : { action: 'status', status: editor.user.status === 'active' ? 'disabled' : 'active' };
    try {
      await teamRequest(editor.action === 'create' ? '' : `/${encodeURIComponent(editor.user.username)}`, teamWriteSchema, { method: editor.action === 'create' ? 'POST' : 'PUT', headers: { 'x-csrf-token': csrfToken }, body: JSON.stringify(payload) });
      setPassword(''); onSaved();
    } catch (failure) { setPassword(''); setError(failure instanceof Error ? failure.message : '保存失败，请刷新核对后重试'); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="team-dialog" aria-labelledby="team-editor-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id="team-editor-title">{title}</h2><button className="team-icon" title="关闭" aria-label="关闭账号编辑" disabled={busy} onClick={onClose}><X size={18}/></button></header>
    <form onSubmit={submit}><fieldset disabled={busy}>
      {editor.action !== 'create' && <p className="team-target">{editor.user.username} · {roleName(editor.user.role)}</p>}
      {editor.action === 'create' && <><label>账号<input required autoFocus minLength={3} maxLength={64} pattern="[A-Za-z0-9._\-]+" autoComplete="off" value={username} onChange={event => setUsername(event.target.value)}/></label><label>姓名（选填）<input maxLength={128} value={displayName} onChange={event => setDisplayName(event.target.value)}/></label></>}
      {(editor.action === 'create' || editor.action === 'role') && <label>账号权限<select value={role} onChange={event => setRole(event.target.value)}><option value="reader">普通账号</option><option value="maintainer">管理员</option></select></label>}
      {(editor.action === 'create' || editor.action === 'password') && <label>临时密码<input required type="password" minLength={6} maxLength={256} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)}/><small>至少 6 位，首次登录必须修改。</small></label>}
      {editor.action === 'role' && <p>权限更改后，该账号的现有会话将失效。</p>}
      {editor.action === 'status' && <p>{editor.user.status === 'active' ? '停用后立即退出登录，无法继续访问看板。可随时重新启用。' : '启用后恢复登录，原有会话不会恢复。'}</p>}
      {error && <p className="team-error" role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>取消</button><button className="team-primary" type="submit">{busy ? '正在保存…' : '确认保存'}</button></footer>
    </fieldset></form>
  </dialog>;
}
