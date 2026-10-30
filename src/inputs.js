'use strict';

const ALERT_FIELDS = ['eventId', 'monitorId', 'title', 'body', 'alertStatus', 'timestamp', 'severity', 'priority',
  'environment', 'configurationItem', 'assignmentGroup', 'team', 'documentation', 'sourceSystem', 'catalogName',
  'catalogOwner', 'catalogSystem', 'catalogSupportGroup', 'catalogType', 'monitorQuery', 'alertScope', 'alertTransition',
  'alertCycleKey', 'endTimestamp', 'followUpOfEventId', 'previousAnalysis', 'link', 'tags', 'service', 'resource', 'hostname',
  'kubeDeployment', 'kubeNamespace', 'metricNamespace', 'source', 'platform', 'firebaseAppId', 'appVersion', 'crashlyticsIssueId', 'firebaseAlertType'];

function codeMindAlert(message, { legacyDatadog = false } = {}) {
  let parsed;
  try { parsed = JSON.parse(message); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const first = (...values) => values.find(value => typeof value === 'string' && value.trim()) ?? null;
  const asText = value => value == null ? null : typeof value === 'string' ? value : JSON.stringify(value);
  const timestamp = value => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  let values;
  let format = 'codemind-agent-input';
  if (Object.hasOwn(parsed, 'alertEvent')) {
    const alert = parsed.alertEvent;
    if (!alert || typeof alert !== 'object' || Array.isArray(alert)) throw new Error('CodeMind alertEvent must be an object.');
    const standardized = alert.standardized || {};
    const source = alert.sourceSystem || {};
    const detail = key => asText(alert.additionalDetails?.[key]);
    values = {
      eventId: first(standardized.id)?.trim(), monitorId: first(detail('alert_id'), source.id),
      title: first(alert.shortDescription, alert.eventName), body: alert.description ?? '',
      alertStatus: first(standardized.state, alert.state), timestamp: timestamp(first(standardized.startTime, alert.startTime)),
      severity: first(standardized.severity, alert.severity), priority: standardized.priority ?? 0,
      environment: alert.environment ?? '', configurationItem: alert.ci ?? '', assignmentGroup: alert.assignmentGroup ?? '',
      team: standardized.team ?? null, documentation: alert.documentation ?? '', sourceSystem: source.name ?? null,
      catalogName: alert.catalog_name ?? '', catalogOwner: alert.catalog_owner ?? '', catalogSystem: alert.catalog_system ?? '',
      catalogSupportGroup: alert.catalog_supportGroup ?? '', catalogType: alert.catalog_type ?? '',
      monitorQuery: detail('alert_query'), alertScope: detail('alert_scope'), alertTransition: detail('alert_transition'),
      alertCycleKey: detail('alert_cycle_key'), endTimestamp: timestamp(first(standardized.endTime, alert.endTime)),
      link: detail('link'), tags: detail('tags'), service: detail('service'), resource: detail('resource'), hostname: detail('hostname'),
      kubeDeployment: detail('kube_deployment'), kubeNamespace: detail('kube_namespace'), metricNamespace: detail('metric_namespace')
    };
    format = 'codemind-mapped-alert';
  } else if (Object.hasOwn(parsed, 'eventId') || Object.hasOwn(parsed, 'EventId')) {
    if (Object.hasOwn(parsed, 'Analysis') || Object.hasOwn(parsed, 'analysis')) {
      throw new Error('Incoming message contains an agent response. Paste the original alert event, not the generated Analysis.');
    }
    const lookup = new Map(Object.entries(parsed).map(([key, value]) => [key.toLowerCase(), value]));
    values = Object.fromEntries(ALERT_FIELDS.map(key => [key, lookup.get(key.toLowerCase())]));
  } else return null;
  if (typeof values.eventId !== 'string' || !values.eventId.trim()) throw new Error('CodeMind incoming alert requires eventId or alertEvent.standardized.id.');
  const alert = Object.fromEntries(ALERT_FIELDS.map(key => [key, values[key] ?? (key === 'priority' ? 0 : null)]));
  if (!Number.isInteger(alert.priority)) throw new Error('CodeMind alert priority must be an integer.');
  for (const key of ALERT_FIELDS.filter(key => key !== 'priority')) {
    if (alert[key] !== null && typeof alert[key] !== 'string') throw new Error('CodeMind alert ' + key + ' must be a string or null.');
  }
  return { format, alert, userPrompt: 'Analyze this ' + (legacyDatadog ? 'Datadog ' : '') + 'alert event:\n' + JSON.stringify(alert) };
}

function agentInstructions(content) {
  const text = String(content ?? '').replace(/^\uFEFF/, '');
  return text.replace(/^---[^\S\r\n]*\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/, '').trim();
}

module.exports = { codeMindAlert, agentInstructions };
