import { type ButtonHTMLAttributes, type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  getGetContactQueryKey,
  getGetDashboardQueryKey,
  getGetGoalQueryKey,
  getGetLadderQueryKey,
  getListEventsQueryKey,
  getListGoalsQueryKey,
  useConfirmContact,
  useCreateEvent,
  useCreateGoal,
  useDeleteGoal,
  useGetContact,
  useGetDashboard,
  useGetGoal,
  useGetLadder,
  useListEvents,
  useListGoals,
  useLockGoal,
  useRequestGoalAmendment,
  useSendChatMessage,
  useUpdateContact,
  useUpdateGoal,
  useUpdateLadder,
} from '@workspace/api-client-react';
import type { Event, Goal, GoalInput } from '@workspace/api-client-react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  FileText,
  Flag,
  History,
  Inbox,
  Lock,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Save,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { ErrorBoundary as RoutedErrorBoundary } from '@/components/error-boundary';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

const fmtDate = (value?: string | null) =>
  value ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value)) : 'Not set';
const fmtTime = (value?: string | null) =>
  value ? new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Not scheduled';
const titleForEvent = (type: string) =>
  ({ check_in: 'Check-in recorded', failure: 'Failure recorded', consequence_issued: 'Consequence issued', consequence_done: 'Consequence completed', note: 'Note added', escalation_sent: 'Escalation sent' } as Record<string, string>)[type] || type;
const statusTone = (status: string) =>
  ({ proposed: 'bg-amber-100 text-amber-900', active: 'bg-teal-100 text-teal-900', locked: 'bg-slate-200 text-slate-800', failed: 'bg-red-100 text-red-900', completed: 'bg-emerald-100 text-emerald-900' } as Record<string, string>)[status] || 'bg-muted text-muted-foreground';
const apiError = (error: unknown) => (error && typeof error === 'object' && 'error' in error ? String((error as { error: unknown }).error) : 'Something went wrong. Try again.');

function Button({ children, className = '', variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const styles = { primary: 'bg-primary text-primary-foreground hover:brightness-110', secondary: 'bg-secondary text-secondary-foreground hover:bg-accent', ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground', danger: 'bg-red-100 text-red-900 hover:bg-red-200' };
  return <button className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition duration-200 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]} ${className}`} {...props}>{children}</button>;
}

function Field({ label, value, onChange, placeholder, multiline = false, type = 'text', testId }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; multiline?: boolean; type?: string; testId: string }) {
  return <label className="grid gap-2 text-sm font-semibold text-foreground"><span>{label}</span>{multiline ? <textarea data-testid={testId} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={3} className="resize-none rounded-xl border bg-background/60 px-3 py-2.5 font-normal outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15" /> : <input data-testid={testId} type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="h-11 rounded-xl border bg-background/60 px-3 font-normal outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15" />}</label>;
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const nav = [{ href: '/', label: 'Command center', icon: CircleDot }, { href: '/goals', label: 'Goals', icon: Flag }, { href: '/history', label: 'History', icon: History }, { href: '/settings', label: 'Settings', icon: Settings }];
  return <div className="min-h-[100dvh] md:grid md:grid-cols-[252px_1fr]">
    <aside className={`${menuOpen ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-0 left-0 z-30 w-[252px] bg-sidebar px-5 py-6 text-sidebar-foreground transition-transform md:static md:translate-x-0`}>
      <div className="mb-12 flex items-center gap-3 px-2"><div className="grid size-9 place-items-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground"><ShieldCheck size={19} /></div><div><p className="font-extrabold tracking-tight">Accountability</p><p className="font-mono text-[10px] uppercase tracking-[.2em] text-sidebar-foreground/55">A factual record</p></div></div>
      <nav className="grid gap-1" aria-label="Primary navigation">{nav.map(({ href, label, icon: Icon }) => <Link key={href} href={href} data-testid={`link-nav-${label.toLowerCase().replace(' ', '-')}`} onClick={() => setMenuOpen(false)} className={`group flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition ${location === href ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground'}`}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{location === href && <ChevronRight className="ml-auto text-sidebar-primary" size={15} />}</Link>)}</nav>
      <div className="absolute inset-x-5 bottom-6 rounded-2xl border border-sidebar-border bg-sidebar-accent/60 p-4"><p className="mb-1 flex items-center gap-2 text-xs font-bold text-sidebar-primary"><Lock size={13} /> Commitments stay visible</p><p className="text-xs leading-relaxed text-sidebar-foreground/55">A record is useful because it does not change with your mood.</p></div>
    </aside>
    {menuOpen && <button aria-label="Close menu" data-testid="button-close-menu" onClick={() => setMenuOpen(false)} className="fixed inset-0 z-20 bg-foreground/20 md:hidden" />}
    <main className="min-w-0"><header className="sticky top-0 z-10 flex h-[72px] items-center justify-between border-b bg-background/85 px-5 backdrop-blur md:px-10"><button data-testid="button-open-menu" aria-label="Open menu" onClick={() => setMenuOpen(true)} className="rounded-lg p-2 md:hidden"><Menu size={21} /></button><div className="hidden text-xs font-semibold text-muted-foreground md:block"><span className="font-mono text-primary">/</span> {location === '/' ? 'Today' : location.slice(1)}</div><div className="ml-auto flex items-center gap-3"><span className="hidden text-right sm:block"><span className="block text-xs font-bold">Private workspace</span><span className="block font-mono text-[10px] text-muted-foreground">LOCAL ACCOUNTABILITY</span></span><div className="grid size-9 place-items-center rounded-full bg-accent text-accent-foreground"><UserRound size={16} /></div></div></header><div className="mx-auto max-w-[1400px] px-5 py-8 md:px-10 md:py-10">{children}</div></main>
  </div>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="mb-8 flex flex-col justify-between gap-5 md:flex-row md:items-end"><div className="page-enter"><p className="mb-2 font-mono text-[11px] font-medium uppercase tracking-[.18em] text-primary">{eyebrow}</p><h1 className="text-3xl font-extrabold tracking-[-.04em] text-foreground md:text-4xl">{title}</h1><p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{description}</p></div>{action}</div>;
}

function LoadingBlock({ label = 'Loading record' }: { label?: string }) { return <div data-testid="status-loading" className="grid min-h-36 place-items-center rounded-2xl border bg-card p-6 text-sm text-muted-foreground"><div className="flex items-center gap-3"><span className="size-2 animate-pulse rounded-full bg-primary" /><span>{label}</span></div></div>; }
function ErrorBlock({ onRetry }: { onRetry?: () => void }) { return <div data-testid="status-error" className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-900"><div className="flex items-center gap-2 font-bold"><AlertTriangle size={16} /> Unable to load this record</div><p className="mt-1 text-red-900/70">The server did not return the current data.</p>{onRetry && <Button data-testid="button-retry" onClick={onRetry} variant="danger" className="mt-4 min-h-9 px-3 text-xs">Try again</Button>}</div>; }

function EventRow({ event, goals }: { event: Event; goals?: Goal[] }) {
  const goal = goals?.find(item => item.id === event.goalId);
  return <div data-testid={`event-row-${event.id}`} className="group flex gap-4 border-b py-4 last:border-0"><div className="mt-1 grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-primary"><FileText size={14} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline justify-between gap-2"><p data-testid={`text-event-title-${event.id}`} className="text-sm font-bold">{titleForEvent(event.type)}</p><time className="font-mono text-[10px] text-muted-foreground">{fmtDate(event.createdAt)}</time></div><p data-testid={`text-event-content-${event.id}`} className="mt-1 text-sm leading-relaxed text-muted-foreground">{event.content}</p>{goal && <p className="mt-2 inline-flex rounded-md bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">{goal.name}</p>}</div></div>;
}

function ChatPanel() {
  const send = useSendChatMessage();
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState<{ message: string; providerConfigured: boolean } | null>(null);
  const submit = (e: FormEvent) => { e.preventDefault(); if (!message.trim()) return; send.mutate({ data: { message: message.trim() } }, { onSuccess: result => { setReply(result); setMessage(''); } }); };
  return <section data-testid="section-chat" className="soft-card overflow-hidden rounded-2xl border bg-card"><div className="flex items-center justify-between border-b px-5 py-4"><div><p className="flex items-center gap-2 text-sm font-bold"><MessageSquare size={16} className="text-primary" /> Ask the record</p><p className="mt-1 text-xs text-muted-foreground">A factual surface, not a coach.</p></div><span className="rounded-full bg-emerald-100 px-2 py-1 font-mono text-[10px] text-emerald-900">PRIVATE</span></div><div className="min-h-32 p-5">{reply ? <div data-testid="chat-response" className={`rounded-xl p-4 text-sm leading-relaxed ${reply.providerConfigured ? 'bg-secondary' : 'border border-amber-200 bg-amber-50 text-amber-950'}`}><p className="mb-2 font-mono text-[10px] uppercase tracking-wider opacity-60">{reply.providerConfigured ? 'Response' : 'Provider not configured'}</p>{reply.message}</div> : <div data-testid="chat-empty" className="flex min-h-24 flex-col justify-center"><p className="text-sm font-semibold">What do you need to verify?</p><p className="mt-1 text-xs text-muted-foreground">Try asking what you committed to, or when the next check-in is due.</p></div>}</div><form onSubmit={submit} className="flex gap-2 border-t p-3"><input data-testid="input-chat-message" value={message} onChange={e => setMessage(e.target.value)} placeholder="Ask about your record..." className="min-w-0 flex-1 rounded-xl border bg-background px-3 text-sm outline-none focus:border-primary" /><Button data-testid="button-send-chat" type="submit" disabled={send.isPending || !message.trim()} className="size-10 shrink-0 p-0" aria-label="Send message">{send.isPending ? <span className="size-3 animate-pulse rounded-full bg-primary-foreground" /> : <Send size={15} />}</Button></form>{send.isError && <p data-testid="status-chat-error" className="px-4 pb-4 text-xs text-red-800">{apiError(send.error)}</p>}</section>;
}

function Home() {
  const dashboard = useGetDashboard();
  const goals = useListGoals();
  const events = useListEvents({ limit: 8 });
  const [checkInText, setCheckInText] = useState('');
  const createEvent = useCreateEvent();
  const qc = useQueryClient();
  const recent = dashboard.data?.recentEvents || events.data || [];
  const active = goals.data?.filter(goal => goal.status === 'active' || goal.status === 'locked') || [];
  const logCheckIn = () => { if (!checkInText.trim()) return; createEvent.mutate({ data: { type: 'check_in', content: checkInText.trim() } }, { onSuccess: () => { setCheckInText(''); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); qc.invalidateQueries({ queryKey: getListEventsQueryKey({ limit: 8 }) }); } }); };
  return <div className="page-enter"><PageHeader eyebrow="Tuesday · command center" title="Keep the record honest." description="A quiet place to see what you said you would do, what happened, and what comes next." action={<Link href="/goals" data-testid="link-propose-goal" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground transition hover:brightness-110"><Plus size={16} /> Propose a goal</Link>} />
    {dashboard.isLoading ? <LoadingBlock label="Loading today's record" /> : dashboard.isError ? <ErrorBlock onRetry={() => dashboard.refetch()} /> : <><div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[['Active goals', dashboard.data?.activeGoals ?? active.length, 'held commitments'], ['Proposed', dashboard.data?.proposedGoals ?? 0, 'awaiting confirmation'], ['Overdue', dashboard.data?.overdueGoals ?? 0, 'need a clear record'], ["Today's check-ins", dashboard.data?.checkInsToday ?? 0, 'logged so far']].map(([label, value, note], i) => <div key={String(label)} data-testid={`metric-${i}`} className={`soft-card rounded-2xl border bg-card p-5 ${i === 2 && Number(value) > 0 ? 'border-red-200' : ''}`}><p className="text-xs font-bold text-muted-foreground">{label}</p><p data-testid={`value-metric-${i}`} className="mt-3 text-3xl font-extrabold tracking-tight">{value}</p><p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{note}</p></div>)}</div><div className="grid gap-6 xl:grid-cols-[1.1fr_.9fr]"><div className="grid gap-6"><section data-testid="section-check-in" className="rounded-2xl border border-primary/20 bg-primary p-6 text-primary-foreground"><div className="flex items-start justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[.2em] text-primary-foreground/60">Today’s check-in</p><h2 className="mt-2 text-xl font-extrabold tracking-tight">{dashboard.data?.checkInsToday ? 'Recorded for today.' : 'Nothing recorded yet.'}</h2><p className="mt-1 max-w-md text-sm leading-relaxed text-primary-foreground/70">Write what actually happened. A short, factual note is enough.</p></div><CheckCircle2 className={dashboard.data?.checkInsToday ? 'text-accent' : 'text-primary-foreground/30'} size={26} /></div><div className="mt-5 flex flex-col gap-2 sm:flex-row"><input data-testid="input-check-in" value={checkInText} onChange={e => setCheckInText(e.target.value)} placeholder="What happened today?" className="h-11 flex-1 rounded-xl border border-primary-foreground/20 bg-primary-foreground/10 px-3 text-sm text-primary-foreground outline-none placeholder:text-primary-foreground/45 focus:border-accent" /><Button data-testid="button-log-check-in" variant="secondary" onClick={logCheckIn} disabled={!checkInText.trim() || createEvent.isPending}><Check size={15} /> Log check-in</Button></div>{createEvent.isError && <p data-testid="status-check-in-error" className="mt-3 text-xs text-red-200">{apiError(createEvent.error)}</p>}</section><section data-testid="section-active-goals" className="soft-card rounded-2xl border bg-card p-5"><div className="mb-3 flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-[.2em] text-primary">In force</p><h2 className="mt-1 text-lg font-extrabold">Current commitments</h2></div><Link href="/goals" data-testid="link-view-goals" className="text-xs font-bold text-primary hover:underline">View all <ArrowRight className="ml-1 inline" size={13} /></Link></div>{goals.isLoading ? <LoadingBlock /> : active.length ? <div className="grid gap-2">{active.slice(0, 4).map(goal => <GoalRow key={goal.id} goal={goal} />)}</div> : <EmptyState icon={<Flag size={18} />} title="No active commitments" body="When you are ready, propose the first one." action={<Link href="/goals" data-testid="link-empty-goals" className="text-sm font-bold text-primary">Open goals</Link>} />}</section></div><div className="grid gap-6"><ChatPanel /><section data-testid="section-recent-events" className="soft-card rounded-2xl border bg-card p-5"><div className="mb-2 flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-[.2em] text-primary">Recent facts</p><h2 className="mt-1 text-lg font-extrabold">What changed</h2></div><Link href="/history" data-testid="link-view-history" className="text-xs font-bold text-primary hover:underline">Full history</Link></div>{events.isLoading ? <LoadingBlock /> : recent.length ? recent.slice(0, 4).map(event => <EventRow key={event.id} event={event} goals={goals.data} />) : <EmptyState icon={<Inbox size={18} />} title="The record is quiet" body="Your factual events will appear here." />}</section></div></div></>}</div>;
}

function GoalRow({ goal, selected = false, onClick }: { goal: Goal; selected?: boolean; onClick?: () => void }) {
  return <button type="button" onClick={onClick} data-testid={`goal-row-${goal.id}`} className={`w-full rounded-xl border p-4 text-left transition hover:-translate-y-0.5 hover:border-primary/40 ${selected ? 'border-primary bg-secondary/60' : 'bg-background/35'}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p data-testid={`text-goal-name-${goal.id}`} className="truncate text-sm font-bold">{goal.name}</p><p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{goal.successCondition}</p></div><span data-testid={`status-goal-${goal.id}`} className={`shrink-0 rounded-full px-2 py-1 font-mono text-[10px] uppercase ${statusTone(goal.status)}`}>{goal.status}</span></div><div className="mt-3 flex items-center gap-3 font-mono text-[10px] text-muted-foreground"><span>{goal.status === 'proposed' ? 'Created' : 'Locked'} {fmtDate(goal.lockedAt || goal.createdAt)}</span>{goal.checkInTime && <><span>·</span><span>Check-in {fmtTime(goal.checkInTime)}</span></>}</div></button>;
}

function GoalForm({ editing, onDone }: { editing?: Goal; onDone: () => void }) {
  const create = useCreateGoal();
  const update = useUpdateGoal();
  const qc = useQueryClient();
  const [name, setName] = useState(editing?.name || '');
  const [successCondition, setSuccess] = useState(editing?.successCondition || '');
  const [failureCondition, setFailure] = useState(editing?.failureCondition || '');
  const [checkInTime, setCheckInTime] = useState(editing?.checkInTime ? new Date(editing.checkInTime).toISOString().slice(11, 16) : '');
  const submit = (e: FormEvent) => { e.preventDefault(); const data: GoalInput = { name: name.trim(), successCondition: successCondition.trim(), failureCondition: failureCondition.trim(), checkInTime: checkInTime ? new Date(`1970-01-01T${checkInTime}:00`).toISOString() : null }; if (editing) update.mutate({ id: editing.id, data }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListGoalsQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); onDone(); } }); else create.mutate({ data }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListGoalsQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); onDone(); } }); };
  const pending = create.isPending || update.isPending;
  return <form data-testid="form-goal" onSubmit={submit} className="grid gap-4 rounded-2xl border border-primary/20 bg-secondary/40 p-5"><div className="flex items-start justify-between"><div><p className="font-mono text-[10px] uppercase tracking-[.2em] text-primary">{editing ? 'Edit proposal' : 'New proposal'}</p><h2 className="mt-1 text-lg font-extrabold">{editing ? 'Make the terms precise.' : 'Name the commitment.'}</h2></div><button type="button" data-testid="button-cancel-goal-form" onClick={onDone} className="rounded-lg p-1 text-muted-foreground hover:bg-background"><X size={17} /></button></div><Field testId="input-goal-name" label="Commitment" value={name} onChange={setName} placeholder="What will you do?" /><Field testId="input-goal-success" label="Success condition" value={successCondition} onChange={setSuccess} placeholder="How will you know it happened?" multiline /><Field testId="input-goal-failure" label="Failure condition" value={failureCondition} onChange={setFailure} placeholder="What counts as not doing it?" multiline /><Field testId="input-goal-check-in" label="Daily check-in time (optional)" value={checkInTime} onChange={setCheckInTime} type="time" /><div className="flex justify-end gap-2"><Button type="button" data-testid="button-cancel-goal" onClick={onDone} variant="ghost">Cancel</Button><Button data-testid="button-save-goal" disabled={pending || !name.trim() || !successCondition.trim() || !failureCondition.trim()}><Save size={15} /> {pending ? 'Saving...' : editing ? 'Save changes' : 'Add proposal'}</Button></div>{(create.isError || update.isError) && <p data-testid="status-goal-form-error" className="text-xs text-red-800">{apiError(create.error || update.error)}</p>}</form>;
}

function Goals() {
  const goals = useListGoals();
  const [showForm, setShowForm] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Goal | undefined>();
  const selectedQuery = useGetGoal(selectedId ?? 0, { query: { enabled: selectedId !== null, queryKey: getGetGoalQueryKey(selectedId ?? 0) } });
  const lock = useLockGoal();
  const del = useDeleteGoal();
  const amend = useRequestGoalAmendment();
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const mutateDone = () => { qc.invalidateQueries({ queryKey: getListGoalsQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); };
  const current = goals.data || [];
  return <div className="page-enter"><PageHeader eyebrow="The commitments" title="Goals, in plain terms." description="Propose what you intend to do. Confirming a goal makes it harder to casually undo and easier to honestly review." action={<Button data-testid="button-new-goal" onClick={() => { setEditing(undefined); setShowForm(true); }}><Plus size={16} /> Propose goal</Button>} />{showForm && <div className="mb-6"><GoalForm editing={editing} onDone={() => { setShowForm(false); setEditing(undefined); }} /></div>}{goals.isLoading ? <LoadingBlock label="Loading commitments" /> : goals.isError ? <ErrorBlock onRetry={() => goals.refetch()} /> : <div className="grid gap-6 lg:grid-cols-[1fr_330px]"><section data-testid="section-goal-list" className="grid content-start gap-3">{current.length ? current.map(goal => <div key={goal.id} className="relative"><GoalRow goal={goal} selected={selectedId === goal.id} onClick={() => setSelectedId(goal.id)} />{selectedId === goal.id && <div className="mt-2 flex flex-wrap gap-2 px-1"><Button data-testid={`button-lock-goal-${goal.id}`} disabled={goal.status !== 'proposed' || lock.isPending} onClick={() => lock.mutate({ id: goal.id }, { onSuccess: mutateDone })} className="min-h-9 px-3 text-xs"><Lock size={14} /> Confirm & lock</Button><Button data-testid={`button-edit-goal-${goal.id}`} variant="secondary" disabled={goal.status !== 'proposed' || !!goal.editUnlockAt && new Date(goal.editUnlockAt) > new Date()} onClick={() => { setEditing(goal); setShowForm(true); }} className="min-h-9 px-3 text-xs">Edit</Button><Button data-testid={`button-amend-goal-${goal.id}`} variant="ghost" disabled={goal.status !== 'locked'} onClick={() => amend.mutate({ id: goal.id }, { onSuccess: mutateDone })} className="min-h-9 px-3 text-xs"><Clock3 size={14} /> Request amendment</Button><Button data-testid={`button-delete-goal-${goal.id}`} variant="danger" onClick={() => setConfirmDelete(goal.id)} className="min-h-9 px-3 text-xs"><Trash2 size={14} /> Delete</Button></div>}{confirmDelete === goal.id && <div data-testid={`confirm-delete-goal-${goal.id}`} className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-900"><span>Delete this proposed commitment?</span><span className="flex gap-1"><Button data-testid={`button-confirm-delete-${goal.id}`} variant="danger" className="min-h-8 px-2 text-xs" onClick={() => del.mutate({ id: goal.id }, { onSuccess: () => { setConfirmDelete(null); setSelectedId(null); mutateDone(); } })}>Delete</Button><Button data-testid={`button-cancel-delete-${goal.id}`} variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => setConfirmDelete(null)}>Keep</Button></span></div>}</div>) : <EmptyState icon={<Flag size={18} />} title="No commitments yet" body="A useful record starts with one specific, observable promise." action={<Button data-testid="button-empty-new-goal" onClick={() => setShowForm(true)}><Plus size={15} /> Propose the first</Button>} />}</section><aside data-testid="section-goal-detail" className="h-fit rounded-2xl border bg-card p-5 lg:sticky lg:top-24">{selectedId === null ? <div className="grid min-h-52 place-items-center text-center"><div><div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-secondary text-primary"><MoreHorizontal size={18} /></div><p className="text-sm font-bold">Select a goal</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">See its terms and the point at which it became real.</p></div></div> : selectedQuery.isLoading ? <LoadingBlock /> : selectedQuery.data ? <div><div className="mb-5 flex items-start justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-widest text-primary">Selected record</p><h2 data-testid="text-selected-goal" className="mt-1 text-xl font-extrabold">{selectedQuery.data.name}</h2></div><span className={`rounded-full px-2 py-1 font-mono text-[10px] uppercase ${statusTone(selectedQuery.data.status)}`}>{selectedQuery.data.status}</span></div><div className="grid gap-4 text-sm"><div><p className="text-xs font-bold text-muted-foreground">Success condition</p><p className="mt-1 leading-relaxed">{selectedQuery.data.successCondition}</p></div><div><p className="text-xs font-bold text-muted-foreground">Failure condition</p><p className="mt-1 leading-relaxed">{selectedQuery.data.failureCondition}</p></div><div className="border-t pt-4 font-mono text-[10px] text-muted-foreground"><p>Proposed {fmtDate(selectedQuery.data.createdAt)}</p><p>Locked {fmtDate(selectedQuery.data.lockedAt)}</p>{selectedQuery.data.editUnlockAt && <p>Amendment window {fmtDate(selectedQuery.data.editUnlockAt)}</p>}</div></div></div> : <ErrorBlock />}</aside></div>}</div>;
}

function HistoryPage() {
  const events = useListEvents({ limit: 100 });
  const goals = useListGoals();
  const [type, setType] = useState('all');
  const filtered = useMemo(() => (events.data || []).filter(event => type === 'all' || event.type === type), [events.data, type]);
  return <div className="page-enter"><PageHeader eyebrow="The paper trail" title="History, without spin." description="A chronological record of check-ins, failures, consequences, and notes. Facts can be reviewed without turning them into a verdict." /><div className="mb-5 flex flex-wrap gap-2">{['all', 'check_in', 'failure', 'consequence_issued', 'consequence_done', 'note', 'escalation_sent'].map(option => <button key={option} data-testid={`filter-event-${option}`} onClick={() => setType(option)} className={`rounded-full border px-3 py-2 font-mono text-[10px] uppercase transition ${type === option ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:border-primary'}`}>{option === 'all' ? 'All events' : option.replaceAll('_', ' ')}</button>)}</div>{events.isLoading ? <LoadingBlock label="Loading the paper trail" /> : events.isError ? <ErrorBlock onRetry={() => events.refetch()} /> : filtered.length ? <section data-testid="section-history-timeline" className="rounded-2xl border bg-card px-5 py-2">{filtered.map(event => <EventRow key={event.id} event={event} goals={goals.data} />)}</section> : <EmptyState icon={<History size={18} />} title="No events match" body="Try another filter, or record the first check-in from the command center." />}</div>;
}

function SettingsPage() {
  const ladder = useGetLadder();
  const contact = useGetContact();
  const updateLadder = useUpdateLadder();
  const updateContact = useUpdateContact();
  const confirm = useConfirmContact();
  const qc = useQueryClient();
  const [tiers, setTiers] = useState<string[] | null>(null);
  const [contactForm, setContactForm] = useState<{ name: string; phoneNumber: string; email: string } | null>(null);
  const currentTiers = tiers ?? ladder.data?.tiers ?? [];
  const currentContact = contactForm ?? (contact.data ? { name: contact.data.name, phoneNumber: contact.data.phoneNumber, email: contact.data.email } : { name: '', phoneNumber: '', email: '' });
  const saveLadder = () => updateLadder.mutate({ data: { tiers: currentTiers.filter(Boolean) } }, { onSuccess: () => { setTiers(null); qc.invalidateQueries({ queryKey: getGetLadderQueryKey() }); } });
  const saveContact = () => updateContact.mutate({ data: currentContact }, { onSuccess: () => { setContactForm(null); qc.invalidateQueries({ queryKey: getGetContactQueryKey() }); } });
  return <div className="page-enter"><PageHeader eyebrow="The safeguards" title="Make the hard parts explicit." description="Set the ladder and choose who can receive an escalation. Consent is a deliberate action, not a checkbox hidden in settings." /><div className="grid gap-6 lg:grid-cols-2">{ladder.isLoading || contact.isLoading ? <LoadingBlock label="Loading safeguards" /> : <><section data-testid="section-ladder" className="rounded-2xl border bg-card p-6"><div className="mb-5 flex items-start justify-between"><div><p className="flex items-center gap-2 text-sm font-bold"><AlertTriangle size={16} className="text-primary" /> Consequence ladder</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">What happens next is easier to follow when decided in advance.</p></div><span className="rounded-full bg-secondary px-2 py-1 font-mono text-[10px] text-muted-foreground">ORDERED</span></div><div className="grid gap-2">{currentTiers.map((tier, index) => <div key={index} className="flex items-center gap-3"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent font-mono text-xs font-bold">{index + 1}</span><input data-testid={`input-ladder-tier-${index}`} value={tier} onChange={e => setTiers(currentTiers.map((item, i) => i === index ? e.target.value : item))} className="h-11 min-w-0 flex-1 rounded-xl border bg-background/60 px-3 text-sm outline-none focus:border-primary" /><button data-testid={`button-remove-tier-${index}`} onClick={() => setTiers(currentTiers.filter((_, i) => i !== index))} className="rounded-lg p-2 text-muted-foreground hover:bg-red-50 hover:text-red-800"><Trash2 size={15} /></button></div>)}<button data-testid="button-add-tier" onClick={() => setTiers([...currentTiers, ''])} className="mt-2 flex items-center gap-2 rounded-xl border border-dashed p-3 text-xs font-bold text-muted-foreground hover:border-primary hover:text-primary"><Plus size={14} /> Add tier</button></div><Button data-testid="button-save-ladder" onClick={saveLadder} disabled={updateLadder.isPending || currentTiers.some(item => !item.trim())} className="mt-5"><Save size={15} /> Save ladder</Button>{updateLadder.isError && <p data-testid="status-ladder-error" className="mt-3 text-xs text-red-800">{apiError(updateLadder.error)}</p>}</section><section data-testid="section-contact" className="rounded-2xl border bg-card p-6"><div className="mb-5 flex items-start justify-between"><div><p className="flex items-center gap-2 text-sm font-bold"><UserRound size={16} className="text-primary" /> Accountability contact</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Someone who may receive an escalation when the record says it is warranted.</p></div><span className={`rounded-full px-2 py-1 font-mono text-[10px] ${contact.data?.consentConfirmedAt ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}>{contact.data?.consentConfirmedAt ? 'CONSENTED' : 'CONSENT NEEDED'}</span></div><div className="grid gap-3"><Field testId="input-contact-name" label="Name" value={currentContact.name} onChange={value => setContactForm({ ...currentContact, name: value })} placeholder="Their name" /><Field testId="input-contact-phone" label="Phone number" value={currentContact.phoneNumber} onChange={value => setContactForm({ ...currentContact, phoneNumber: value })} placeholder="+1 555 000 0000" /><Field testId="input-contact-email" label="Email (optional)" value={currentContact.email} onChange={value => setContactForm({ ...currentContact, email: value })} placeholder="name@example.com" type="email" /></div><div className="mt-5 flex flex-wrap gap-2"><Button data-testid="button-save-contact" onClick={saveContact} disabled={updateContact.isPending || !currentContact.name || currentContact.phoneNumber.length < 7}><Save size={15} /> Save contact</Button><Button data-testid="button-confirm-contact" variant={contact.data?.consentConfirmedAt ? 'secondary' : 'primary'} onClick={() => confirm.mutate(undefined, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetContactQueryKey() }) })} disabled={confirm.isPending || !contact.data?.id || !!contact.data?.consentConfirmedAt}><CheckCircle2 size={15} /> {contact.data?.consentConfirmedAt ? `Confirmed ${fmtDate(contact.data.consentConfirmedAt)}` : 'Confirm consent'}</Button></div>{contact.data?.consentConfirmedAt ? <p data-testid="status-contact-consent" className="mt-4 flex items-start gap-2 rounded-xl bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-900"><Check size={15} className="mt-0.5 shrink-0" /> Consent confirmed on {fmtDate(contact.data.consentConfirmedAt)}. This contact may be used for escalations.</p> : <p data-testid="status-contact-pending" className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-950"><ShieldCheck size={15} className="mt-0.5 shrink-0" /> Save the contact, then explicitly confirm that they have consented to be part of this system.</p>}{(updateContact.isError || confirm.isError) && <p data-testid="status-contact-error" className="mt-3 text-xs text-red-800">{apiError(updateContact.error || confirm.error)}</p>}</section></>}</div></div>;
}

function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) { return <div data-testid={`empty-${title.toLowerCase().replaceAll(' ', '-')}`} className="grid min-h-48 place-items-center rounded-2xl border border-dashed bg-background/30 p-8 text-center"><div><div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-secondary text-primary">{icon}</div><p className="text-sm font-bold">{title}</p><p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">{body}</p>{action && <div className="mt-4">{action}</div>}</div></div>; }

function Router() { const [location] = useLocation(); return <RoutedErrorBoundary resetKey={location}><Shell><Switch><Route path="/" component={Home} /><Route path="/goals" component={Goals} /><Route path="/history" component={HistoryPage} /><Route path="/settings" component={SettingsPage} /><Route component={NotFound} /></Switch></Shell></RoutedErrorBoundary>; }
function App() { return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>; }
export default App;