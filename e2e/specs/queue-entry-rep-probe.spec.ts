/* eslint-disable playwright/expect-expect, playwright/no-conditional-in-test */
import dayjs from 'dayjs';
import { type Visit } from '@openmrs/esm-framework';
import { test } from '../core';

// TEMPORARY DIAGNOSTIC — delete once the stalled queue table query is understood.
// The queue table's `queue-entry?…&isEnded=false` request never returns once a matching entry exists,
// while the same request with `&status=` answers in about a second. This probes the endpoint directly
// with several representations to find which part of the query stalls.

const outpatientClinic = '44c3efb0-2583-4c80-a79e-1f756a03c0a1';
const facilityVisitType = '7b0f5697-27e3-40c4-8bae-f4049abfb4ed';
const outpatientConsultationQueue = '13b656d3-e141-11ee-bad2-0242ac120002';
const notUrgentPriority = 'f4620bfa-3625-4883-bd3f-84c2cce14470';
const waitingStatus = '51ae5e4d-b72b-4912-bf31-a17efb690aeb';
const omrsDatetime = 'YYYY-MM-DDTHH:mm:ss.SSSZZ';

const branchRep =
  'custom:(uuid,display,queue:(uuid,display,name),status:(uuid,display),patient:(uuid,display,person:(uuid,display,age,birthdate,gender),identifiers:(uuid,identifier,identifierType:(uuid,display))),visit:(uuid,startDatetime,attributes:(uuid,value,attributeType:(uuid))),priority:(uuid,display),priorityComment,sortWeight,startedAt,endedAt,queueComingFrom:(uuid,display),previousQueueEntry:(uuid,startedAt,status:(uuid,display)))';

const mainRep =
  'custom:(uuid,display,queue,status,patient:(uuid,display,person,identifiers:(uuid,display,identifier,identifierType)),visit:(uuid,display,startDatetime,encounters:(uuid,display,diagnoses,encounterDatetime,encounterType,obs,encounterProviders,voided),attributes:(uuid,display,value,attributeType)),priority,priorityComment,sortWeight,startedAt,endedAt,locationWaitingFor,queueComingFrom,providerWaitingFor,previousQueueEntry)';

const withoutPreviousQueueEntry = branchRep.replace(',previousQueueEntry:(uuid,startedAt,status:(uuid,display))', '');
const withoutVisit = branchRep.replace(',visit:(uuid,startDatetime,attributes:(uuid,value,attributeType:(uuid)))', '');
const withoutPatient = branchRep.replace(
  ',patient:(uuid,display,person:(uuid,display,age,birthdate,gender),identifiers:(uuid,identifier,identifierType:(uuid,display)))',
  '',
);

const probes: Array<{ name: string; rep?: string; status?: boolean; totalCount?: boolean }> = [
  { name: 'branch rep, with status (control)', rep: branchRep, status: true },
  { name: 'branch rep, no status', rep: branchRep },
  { name: 'branch rep, no status, no totalCount', rep: branchRep, totalCount: false },
  { name: 'main rep, no status', rep: mainRep },
  { name: 'branch rep minus previousQueueEntry', rep: withoutPreviousQueueEntry },
  { name: 'branch rep minus visit', rep: withoutVisit },
  { name: 'branch rep minus patient', rep: withoutPatient },
  { name: 'custom:(uuid) only', rep: 'custom:(uuid)' },
  { name: 'no v param', rep: undefined },
];

test('Probe which queue-entry representation stalls', async ({ api, patient }) => {
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

  const results: string[] = [];

  const bare = async (label: string) => {
    const start = Date.now();
    try {
      const res = await api.get(`queue-entry?totalCount=true&location=${outpatientClinic}&isEnded=false`, {
        timeout: 15_000,
      });
      const body = await res.text();
      results.push(`${label}: ${res.status()} in ${Date.now() - start}ms, ${body.length} bytes`);
    } catch (error) {
      results.push(`${label}: FAILED after ${Date.now() - start}ms`);
    }
  };

  await bare('no status, BEFORE creating the entry');

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

  for (const probe of probes) {
    const params = new URLSearchParams();
    if (probe.rep) {
      params.append('v', probe.rep);
    }
    if (probe.totalCount !== false) {
      params.append('totalCount', 'true');
    }
    params.append('location', outpatientClinic);
    params.append('isEnded', 'false');
    if (probe.status) {
      params.append('status', waitingStatus);
    }

    const start = Date.now();
    try {
      const res = await api.get(`queue-entry?${params.toString()}`, { timeout: 15_000 });
      const body = await res.text();
      results.push(`${probe.name}: ${res.status()} in ${Date.now() - start}ms, ${body.length} bytes`);
    } catch (error) {
      results.push(`${probe.name}: FAILED after ${Date.now() - start}ms — ${(error as Error).message.split('\n')[0]}`);
    }
  }

  await api.delete(`queue-entry/${queueEntry.uuid}`);
  await bare('no status, AFTER voiding the entry');
  await api.delete(`visit/${visit.uuid}`);

  // eslint-disable-next-line no-console
  console.log(['', 'QUEUE ENTRY REP PROBE RESULTS', ...results, ''].join('\n'));
});

// Same two queries, issued from the page so a service worker or the browser itself is in the path.
test('Probe the same queries from inside the browser', async ({ api, page, patient }) => {
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

  // A page where the service queues app is not mounted, so the only queue-entry traffic is this probe's
  await page.goto(`${process.env.E2E_BASE_URL}/spa/home/appointments`);

  const results = await page.evaluate(
    async ({ rep, status, location }) => {
      const probe = async (name: string, url: string) => {
        const start = performance.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const res = await fetch(url, { signal: controller.signal });
          const body = await res.text();
          return `${name}: ${res.status} in ${Math.round(performance.now() - start)}ms, ${body.length} bytes`;
        } catch (error) {
          return `${name}: FAILED after ${Math.round(performance.now() - start)}ms — ${(error as Error).name}`;
        } finally {
          clearTimeout(timer);
        }
      };

      const base = `/openmrs/ws/rest/v1/queue-entry?v=${encodeURIComponent(rep)}&totalCount=true&location=${location}&isEnded=false`;
      const single = await probe('1. single no-status query', base);
      const concurrent = await Promise.all([
        probe('2a. concurrent no-status', `${base}&probe=a`),
        probe('2b. concurrent no-status', `${base}&probe=b`),
      ]);
      return [
        `service worker controlling the page: ${Boolean(navigator.serviceWorker?.controller)}`,
        single,
        ...concurrent,
        await probe('3. with status', `${base}&status=${status}`),
      ];
    },
    { rep: branchRep, status: waitingStatus, location: outpatientClinic },
  );

  await api.delete(`queue-entry/${queueEntry.uuid}`);
  await api.delete(`visit/${visit.uuid}`);

  // eslint-disable-next-line no-console
  console.log(['', 'IN-PAGE PROBE RESULTS', ...results, ''].join('\n'));
});
