import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../../hooks/use-auth.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import { createAdminApi, type UserSummary } from "../../../services/admin-api.ts";
import { AccountWizard } from "../../account-wizard/AccountWizard.tsx";
import {
  ActionButton,
  ActionRow,
  AsyncState,
  Avatar,
  Dialog,
  PaneChrome,
  RolePill,
  SettingsCard,
} from "../../common/index.ts";

import { useSettingsBusyState } from "../navigation-state.ts";

const log = createLogger(["sentient", "webui", "settings", "members-pane"]);
const POOL_SIZE = 3;
type LoadState = "loading" | "ready" | "forbidden" | "error";

export function MembersPane(): JSX.Element {
  const auth = useAuth();
  const toast = useToast();
  const api = useMemo(() => createAdminApi(), []);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [, setBusy] = useSettingsBusyState();
  const [wizardBusy, setWizardBusy] = useSettingsBusyState();
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSummary | null>(null);
  const [toggleTarget, setToggleTarget] = useState<UserSummary | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const isAuthed = auth.status === "authenticated";
  const token = isAuthed ? auth.token : "";
  const authUserId = isAuthed ? auth.user.userId : "";

  const fetchUsers = useCallback(async () => {
    if (!isAuthed) return;
    setLoadState("loading");
    const result = await api.listUsers(token);
    if (result.ok) {
      setUsers(result.value.users);
      setLoadState("ready");
      return;
    }
    log.warn("list.failed", { code: result.error.code, status: result.error.status });
    setLoadState(result.error.status === 403 ? "forbidden" : "error");
  }, [api, isAuthed, token]);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);
  if (!isAuthed) return <></>;

  const slotsFree = Math.max(0, POOL_SIZE - users.length);
  const recoverFromForbidden = (status: number | undefined): boolean => {
    if (status !== 403) return false;
    setLoadState("forbidden");
    setDeleteTarget(null);
    setToggleTarget(null);
    return true;
  };

  const handleToggleAdmin = async (user: UserSummary) => {
    setBusy(true);
    setBusyUserId(user.userId);
    const result = await api.setIsAdmin(token, user.userId, !user.isAdmin);
    setBusyUserId(null);
    setBusy(false);
    setToggleTarget(null);
    if (result.ok) {
      setUsers((current) => current.map((item) => item.userId === user.userId ? result.value.user : item));
      toast.show(!user.isAdmin ? "Promoted to Admin" : "Demoted to Member");
    } else if (!recoverFromForbidden(result.error.status)) {
      toast.show(result.error.code === "last-admin" ? "Can't demote the only admin" : "Failed to update role", "error");
    }
  };

  const handleDelete = async (user: UserSummary) => {
    setBusy(true);
    setBusyUserId(user.userId);
    const result = await api.deleteUser(token, user.userId);
    setBusyUserId(null);
    setBusy(false);
    setDeleteTarget(null);
    if (result.ok) {
      setUsers((current) => current.filter((item) => item.userId !== user.userId));
      toast.show("Member removed");
    } else if (!recoverFromForbidden(result.error.status)) {
      toast.show(result.error.code === "last-admin" ? "Can't delete the only admin" : "Failed to delete member", "error");
    }
  };

  const handleAddComplete = (summary: UserSummary) => {
    log.info("add-user.complete", { userId: summary.userId });
    setUsers((current) => [...current, summary]);
    toast.show(`${summary.displayName} added`);
    setAddOpen(false);
  };

  return (
    <PaneChrome title="Members" subtitle="Everyone with an account in this household." className="owned-pane">
      {loadState === "loading" && <AsyncState state="loading" title="Loading members" />}
      {loadState === "forbidden" && (
        <AsyncState state="error" title="Admin access required" message="Your account no longer has permission to manage household members." action={<ActionButton onClick={() => void fetchUsers()}>Try again</ActionButton>} />
      )}
      {loadState === "error" && (
        <AsyncState state="error" title="Members unavailable" message="The household roster could not be loaded." action={<ActionButton onClick={() => void fetchUsers()}>Try again</ActionButton>} />
      )}
      {loadState === "ready" && (
        <SettingsCard
          title="Household"
          subtitle={`${users.length} active · ${slotsFree} slot${slotsFree === 1 ? "" : "s"} free`}
          action={<ActionButton variant="quiet" onClick={() => setAddOpen(true)} disabled={slotsFree === 0} title={slotsFree === 0 ? `All ${POOL_SIZE} slots are in use` : "Add a member"}>Add user</ActionButton>}
          padded={false}
        >
          <div class="owned-member-list">
            {users.map((user) => (
              <div key={user.userId} class="owned-member-row">
                <Avatar kind="user" initial={user.displayName.charAt(0)} name={user.displayName} size="lg" />
                <div class="owned-member-name"><strong>{user.displayName}</strong>{user.userId === authUserId && <span> · you</span>}</div>
                <RolePill role={user.isAdmin ? "admin" : "guest"} label={user.isAdmin ? "Admin" : "Member"} />
                {user.userId !== authUserId && (
                  <ActionRow>
                    <ActionButton variant="quiet" loading={busyUserId === user.userId} onClick={() => setToggleTarget(user)}>{user.isAdmin ? "Demote" : "Promote"}</ActionButton>
                    <ActionButton variant="destructive" disabled={busyUserId === user.userId} onClick={() => setDeleteTarget(user)}>Remove</ActionButton>
                  </ActionRow>
                )}
              </div>
            ))}
          </div>
        </SettingsCard>
      )}

      {addOpen && <Dialog title="Add user" closeOnBackdrop={!wizardBusy} closeOnEscape={!wizardBusy} onClose={() => !wizardBusy && setAddOpen(false)} width={560}><AccountWizard mode="admin" adminToken={token} onComplete={handleAddComplete} onBusyChange={setWizardBusy} onCancel={() => !wizardBusy && setAddOpen(false)} /></Dialog>}
      {deleteTarget && (
        <Dialog title={`Remove ${deleteTarget.displayName}?`} description="This signs them out and removes their assistant profile. This cannot be undone." onClose={() => setDeleteTarget(null)} footer={<ActionRow><ActionButton variant="quiet" onClick={() => setDeleteTarget(null)}>Cancel</ActionButton><ActionButton variant="destructive" loading={busyUserId === deleteTarget.userId} onClick={() => void handleDelete(deleteTarget)}>Remove</ActionButton></ActionRow>} />
      )}
      {toggleTarget && (
        <Dialog title={`${toggleTarget.isAdmin ? "Demote" : "Promote"} ${toggleTarget.displayName}?`} description={toggleTarget.isAdmin ? "They will be signed out on every device and another admin must restore their admin access." : "They will be signed out on every device before their new admin access takes effect."} onClose={() => setToggleTarget(null)} footer={<ActionRow><ActionButton variant="quiet" onClick={() => setToggleTarget(null)}>Cancel</ActionButton><ActionButton variant={toggleTarget.isAdmin ? "destructive" : "primary"} loading={busyUserId === toggleTarget.userId} onClick={() => void handleToggleAdmin(toggleTarget)}>{toggleTarget.isAdmin ? "Demote" : "Promote"}</ActionButton></ActionRow>} />
      )}
    </PaneChrome>
  );
}
