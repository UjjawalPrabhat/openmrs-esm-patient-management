/* eslint-disable playwright/expect-expect */
import dayjs from 'dayjs';
import { type Visit } from '@openmrs/esm-framework';
import { test } from '../core';

// TEMPORARY DIAGNOSTIC — does the unfiltered queue-entry query stop answering after N calls?

const outpatientClinic = '44c3efb0-2583-4c80-a79e-1f756a03c0a1';
const facilityVisitType = '7b0f5697-27e3-40c4-8bae-f4049abfb4ed';
const outpatientConsultationQueue = '13b656d3-e141-11ee-bad2-0242ac120002';
const notUrgentPriority = 'f4620bfa-3625-4883-bd3f-84c2cce14470';
const waitingStatus = '51ae5e4d-b72b-4912-bf31-a17efb690aeb';
const omrsDatetime = 'YYYY-MM-DDTHH:mm:ss.SSSZZ';

test('Does the unfiltered query degrade with repetition', async ({ api, patient }) => {
  const visit: Visit = await (
    await api.post('visit', {
      data: {
        startDatetime: dayjs().format(omrsDatetime),
        patient: patient.uuid,
        location: outpatientClinic,
        visitType: facilityVisitType,
        attributes: [],
      },
    })
  ).json();
  const queueEntry = await (
    await api.post('queue-entry', {
      data: {
        queue: outpatientConsultationQueue,
        patient: patient.uuid,
        visit: visit.uuid,
        priority: notUrgentPriority,
        status: waitingStatus,
        startedAt: dayjs().format(omrsDatetime),
      },
    })
  ).json();

  const results: string[] = [];
  const noStatus = `totalCount=true&location=${outpatientClinic}&isEnded=false`;

  for (let i = 1; i <= 60; i++) {
    const start = Date.now();
    try {
      const res = await api.get(`queue-entry?${noStatus}&probe=${i}`, { timeout: 15_000 });
      const ms = Date.now() - start;
      await res.text();
      if (i % 10 === 0 || ms > 1000) {
        results.push(`call ${i}: ${res.status()} in ${ms}ms`);
      }
    } catch {
      results.push(`call ${i}: STALLED after ${Date.now() - start}ms`);
      // Does a status-filtered call still work once the unfiltered one has stalled?
      const start2 = Date.now();
      try {
        const res2 = await api.get(`queue-entry?${noStatus}&status=${waitingStatus}`, { timeout: 15_000 });
        results.push(`  status-filtered right after: ${res2.status()} in ${Date.now() - start2}ms`);
      } catch {
        results.push(`  status-filtered right after: STALLED after ${Date.now() - start2}ms`);
      }
      break;
    }
  }

  await api.delete(`queue-entry/${queueEntry.uuid}`);
  await api.delete(`visit/${visit.uuid}`);

  // eslint-disable-next-line no-console
  console.log(['', 'REPETITION PROBE RESULTS', ...results, ''].join('\n'));
});
