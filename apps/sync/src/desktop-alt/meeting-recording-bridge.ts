import { meetings } from '@hq/ui';
import * as native from '../lib/activeMeetings';

/** Connect the native recorder to the platform-free Meetings page for one auth session. */
export function startMeetingRecordingBridge(): () => void {
  native.resetActiveMeetings();
  let closed = false;
  const unsubscribeMeetings = native.activeMeetings.subscribe(meetings.activeMeetings.set);
  const unsubscribeMemberships = native.recordingMemberships.subscribe(meetings.recordingMemberships.set);
  meetings.configureRecordingControls({
    startRecording: (id) => closed ? Promise.resolve() : native.startRecording(id),
    stopRecording: (id) => closed ? Promise.resolve() : native.stopRecording(id),
    setRecordingCompany: (id, companyUid) => {
      if (!closed) native.setRecordingCompany(id, companyUid);
    },
  });

  // Subscribe before seeding so opening the window cannot lose a detection.
  // The always-present controller owns notification actions; this host only
  // observes their recording events and handles explicit page buttons.
  void native.ensureActiveMeetingListeners({ handleNotificationActions: false })
    .then(async () => {
      if (closed) return;
      await Promise.all([
        native.seedActiveMeetingsFromBackend(),
        native.loadRecordingCompanyContext(),
      ]);
    })
    .catch((error) => console.warn('Meeting recording bridge could not start:', error));

  const onFocus = () => {
    if (!closed) void native.loadRecordingCompanyContext();
  };
  window.addEventListener('focus', onFocus);
  return () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('focus', onFocus);
    unsubscribeMeetings();
    unsubscribeMemberships();
    meetings.configureRecordingControls(null);
    meetings.activeMeetings.set([]);
    meetings.recordingMemberships.set([]);
    native.resetActiveMeetings();
  };
}
