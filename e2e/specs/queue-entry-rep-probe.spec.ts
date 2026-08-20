/* eslint-disable playwright/expect-expect */
import dayjs from 'dayjs';
import { type Visit } from '@openmrs/esm-framework';
import { test } from '../core';

// TEMPORARY DIAGNOSTIC — finds which teardown step makes the unfiltered queue-entry query stop answering.

const outpatientClinic = '44c3efb0-2583-4c80-a79e-1f756a03c0a1';
const facilityVisitType = '7b0f5697-27e3-40c4-8bae-f4049abfb4ed';
const visitNoteEncounterType = 'd7151f82-c1f3-4152-a605-2f9ea7414a79';
const encounterNoteTextConcept = '162169AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const outpatientConsultationQueue = '13b656d3-e141-11ee-bad2-0242ac120002';
const notUrgentPriority = 'f4620bfa-3625-4883-bd3f-84c2cce14470';
const waitingStatus = '51ae5e4d-b72b-4912-bf31-a17efb690aeb';
const omrsDatetime = 'YYYY-MM-DDTHH:mm:ss.SSSZZ';

test('Find the teardown step that stalls the unfiltered query', async ({ api, patient }) => {
  const results: string[] = [];
  const noStatus = `totalCount=true&location=${outpatientClinic}&isEnded=false`;
  let probeCount = 0;

  const probe = async (label: string) => {
    probeCount += 1;
    const start = Date.now();
    try {
      const res = await api.get(`queue-entry?${noStatus}&probe=${probeCount}`, { timeout: 15_000 });
      results.push(`${label}: ${res.status()} in ${Date.now() - start}ms, ${(await res.text()).length} bytes`);
    } catch {
      results.push(`${label}: STALLED (>${Date.now() - start}ms)`);
    }
  };

  const post = async (path: string, data: Record<string, unknown>) => (await api.post(path, { data })).json();

  await probe('01 baseline, nothing created');

  const visitStart = dayjs().subtract(1, 'day').hour(9).minute(0).second(0);
  const pastVisit: Visit = await post('visit', {
    startDatetime: visitStart.format(omrsDatetime),
    stopDatetime: visitStart.add(3, 'hour').format(omrsDatetime),
    patient: patient.uuid,
    location: outpatientClinic,
    visitType: facilityVisitType,
    attributes: [],
  });
  const encounter = await post('encounter', {
    encounterDatetime: visitStart.add(1, 'hour').format(omrsDatetime),
    patient: patient.uuid,
    location: outpatientClinic,
    encounterType: visitNoteEncounterType,
    visit: pastVisit.uuid,
    obs: [{ concept: { uuid: encounterNoteTextConcept }, value: 'probe note' }],
  });
  await probe('02 after past visit + encounter');

  const activeVisit: Visit = await post('visit', {
    startDatetime: dayjs().format(omrsDatetime),
    patient: patient.uuid,
    location: outpatientClinic,
    visitType: facilityVisitType,
    attributes: [],
  });
  const queueEntry = await post('queue-entry', {
    queue: outpatientConsultationQueue,
    patient: patient.uuid,
    visit: activeVisit.uuid,
    priority: notUrgentPriority,
    status: waitingStatus,
    startedAt: dayjs().format(omrsDatetime),
  });
  await probe('03 after active visit + queue entry');

  await api.delete(`queue-entry/${queueEntry.uuid}`);
  await probe('04 after voiding the queue entry');

  await api.delete(`encounter/${encounter.uuid}`);
  await probe('05 after voiding the encounter');

  await api.delete(`visit/${activeVisit.uuid}`);
  await probe('06 after voiding the active visit');

  await api.delete(`visit/${pastVisit.uuid}`);
  await probe('07 after voiding the past visit');

  // eslint-disable-next-line no-console
  console.log(['', 'TEARDOWN PROBE RESULTS', ...results, ''].join('\n'));
});
