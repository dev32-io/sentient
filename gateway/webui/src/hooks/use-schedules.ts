import type { Schedule } from "@sentient/protocol";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { type ScheduleApiError, type SchedulesApi, createSchedulesApi } from "../services/schedules-api.ts";

export interface SchedulesState {
  schedules: readonly Schedule[];
  loading: boolean;
  pendingId: string | null;
  error: ScheduleApiError | null;
  refresh(): Promise<void>;
  save(schedule: Schedule | null, input: Parameters<SchedulesApi["create"]>[1]): Promise<boolean>;
  setEnabled(schedule: Schedule, enabled: boolean): Promise<void>;
  remove(schedule: Schedule): Promise<void>;
}

export function useSchedules(token: string, suppliedApi?: SchedulesApi): SchedulesState {
  const api = useMemo(() => suppliedApi ?? createSchedulesApi(), [suppliedApi]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<ScheduleApiError | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await api.list(token);
    if (result.ok) setSchedules(result.value.schedules);
    else setError(result.error);
    setLoading(false);
  }, [api, token]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const apply = async (id: string, operation: () => ReturnType<SchedulesApi["patch"]>): Promise<boolean> => {
    setPendingId(id);
    setError(null);
    const result = await operation();
    setPendingId(null);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setSchedules((items) => [result.value, ...items.filter((item) => item.scheduleId !== result.value.scheduleId)]);
    return true;
  };
  return {
    schedules,
    loading,
    pendingId,
    error,
    refresh,
    async save(schedule, input) {
      if (!schedule) {
        setPendingId("new");
        setError(null);
        const result = await api.create(token, input);
        setPendingId(null);
        if (!result.ok) {
          setError(result.error);
          return false;
        }
        setSchedules((items) => [result.value, ...items]);
        return true;
      }
      return apply(schedule.scheduleId, () =>
        api.patch(token, schedule.scheduleId, {
          expectedRevision: schedule.revision,
          changes: { message: input.message, timing: input.timing, enabled: input.enabled },
        }),
      );
    },
    async setEnabled(schedule, enabled) {
      await apply(schedule.scheduleId, () =>
        api.patch(token, schedule.scheduleId, { expectedRevision: schedule.revision, changes: { enabled } }),
      );
    },
    async remove(schedule) {
      setPendingId(schedule.scheduleId);
      setError(null);
      const result = await api.delete(token, schedule.scheduleId, schedule.revision);
      setPendingId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSchedules((items) => items.filter((item) => item.scheduleId !== schedule.scheduleId));
    },
  };
}
