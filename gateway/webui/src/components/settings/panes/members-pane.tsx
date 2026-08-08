// gateway/webui/src/components/settings/panes/members-pane.tsx
import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../../hooks/use-auth.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import { createAdminApi, type UserSummary } from "../../../services/admin-api.ts";
import { AccountWizard } from "../../account-wizard/AccountWizard.tsx";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Btn } from "../primitives/btn.tsx";
import { Modal } from "../primitives/modal.tsx";
import { Icon } from "../../common/icon.tsx";
import { SpinnerOverlay } from "../../common/spinner-overlay.tsx";

const log = createLogger(["sentient", "webui", "settings", "members-pane"]);
const POOL_SIZE = 3;

export function MembersPane(): JSX.Element {
  const auth = useAuth();
  const toast = useToast();
  const api = createAdminApi();

  const [users, setUsers] = useState<UserSummary[]>([]);
  const [applying, setApplying] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UserSummary | null>(null);
  const [toggleTarget, setToggleTarget] = useState<UserSummary | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const isAuthed = auth.status === "authenticated";
  const token = isAuthed ? auth.token : "";
  const authUserId = isAuthed ? auth.user.userId : "";

  const fetchUsers = useCallback(async () => {
    if (!isAuthed) return;
    const r = await api.listUsers(token);
    if (r.ok) setUsers(r.value.users);
    else {
      log.warn("list.failed", { code: r.error.code });
      toast.show("Failed to load members", "error");
    }
  }, [isAuthed, token]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  if (!isAuthed) return <></>;

  const slotsFree = POOL_SIZE - users.length;

  function handleAddComplete(summary: UserSummary): void {
    log.info("add-user.complete", { userId: summary.userId });
    setUsers((u) => [...u, summary]);
    toast.show(`${summary.displayName} added`);
    setAddOpen(false);
  }

  const handleToggleAdmin = async (u: UserSummary) => {
    setToggleTarget(null);
    const r = await api.setIsAdmin(token, u.userId, !u.isAdmin);
    if (r.ok) {
      setUsers((arr) => arr.map((x) => (x.userId === u.userId ? r.value.user : x)));
      toast.show(!u.isAdmin ? "Promoted to Admin" : "Demoted to Member");
    } else {
      toast.show(
        r.error.code === "last-admin" ? "Can't demote the only admin" : "Failed to update role",
        "error",
      );
    }
  };

  const handleDelete = async (u: UserSummary) => {
    setDeleteTarget(null);
    setApplying(true);
    const r = await api.deleteUser(token, u.userId);
    setApplying(false);
    if (r.ok) {
      setUsers((arr) => arr.filter((x) => x.userId !== u.userId));
      toast.show("Member removed");
    } else {
      toast.show(
        r.error.code === "last-admin" ? "Can't delete the only admin" : "Failed to delete member",
        "error",
      );
    }
  };

  return (
    <>
      <SpinnerOverlay open={applying} heading="Applying changes…" body="This may take a moment — do not close this tab" />

      <PaneHead title="Members" sub="Everyone with a recognized voice or account in this home." />

      <Card
        title="Household"
        sub={`${users.length} active · ${slotsFree} slot${slotsFree === 1 ? "" : "s"} free`}
        action={
          <Btn
            kind="ghost"
            size="sm"
            icon={<Icon name="plus" size={11} />}
            onClick={() => setAddOpen(true)}
            disabled={slotsFree === 0}
            {...(slotsFree === 0 ? { title: `All ${POOL_SIZE} slots are in use` } : {})}
          >
            Add user
          </Btn>
        }
        padding={false}
      >
        <div class="member-list">
          {users.map((u) => (
            <div key={u.userId} class="member">
              <div class="avatar" style={{ background: u.avatarTint || "var(--color-bg-elev)" }}>
                {u.displayName.charAt(0).toUpperCase()}
              </div>
              <div class="info">
                <div class="name">
                  {u.displayName}
                  {u.userId === authUserId && <span class="muted xs"> · you</span>}
                </div>
                <div class="sub">{u.isAdmin ? "Admin" : "Member"}</div>
              </div>
              <span class={["role-pill", u.isAdmin ? "admin" : "member"].join(" ")}>
                {u.isAdmin ? "Admin" : "Member"}
              </span>
              {u.userId !== authUserId && (
                <div class="lst-acts">
                  <Btn kind="ghost" size="sm" onClick={() => setToggleTarget(u)}>
                    {u.isAdmin ? "Demote" : "Promote"}
                  </Btn>
                  <Btn
                    kind="ghost"
                    size="sm"
                    danger
                    title="Remove member"
                    onClick={() => setDeleteTarget(u)}
                  >
                    <Icon name="trash" size={14} />
                  </Btn>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {addOpen && (
        <Modal
          title="Add user"
          onClose={() => setAddOpen(false)}
          width={560}
        >
          <AccountWizard
            mode="admin"
            adminToken={token}
            onComplete={handleAddComplete}
            onCancel={() => setAddOpen(false)}
          />
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title={`Remove ${deleteTarget.displayName}?`}
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <Btn kind="ghost" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Btn>
              <Btn kind="primary" size="sm" danger onClick={() => void handleDelete(deleteTarget)}>
                Remove
              </Btn>
            </>
          }
        >
          <p class="modal-lead">This signs them out and removes their agent. This cannot be undone.</p>
        </Modal>
      )}

      {toggleTarget && (
        <Modal
          title={`${toggleTarget.isAdmin ? "Demote" : "Promote"} ${toggleTarget.displayName}?`}
          onClose={() => setToggleTarget(null)}
          footer={
            <>
              <Btn kind="ghost" size="sm" onClick={() => setToggleTarget(null)}>Cancel</Btn>
              <Btn
                kind="primary"
                size="sm"
                danger={toggleTarget.isAdmin}
                onClick={() => void handleToggleAdmin(toggleTarget)}
              >
                {toggleTarget.isAdmin ? "Demote" : "Promote"}
              </Btn>
            </>
          }
        >
          <p class="modal-lead">
            {toggleTarget.isAdmin
              ? `This signs ${toggleTarget.displayName} out on every device, right now. Once demoted, they can't restore their own admin access — only another admin can promote them back.`
              : `This signs ${toggleTarget.displayName} out on every device, right now. They'll need to log back in before they can use their new admin access.`}
          </p>
        </Modal>
      )}
    </>
  );
}
