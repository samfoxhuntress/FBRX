import { formatTokens } from '@fbrx/shared';
import { BarList, Button, Callout, Card, Empty, Grid, KeyValue, LineChart, Meter, Page, StatTile, formatDay } from '@fbrx/ui';
import { useCore } from '../hooks';
import { navigate } from '../app';

/**
 * AI usage: what the AI read and wrote on this computer this month (only counts are kept, never what was said), by day
 * and by model; the monthly cloud AI budget; what the agent chats use now holds; and the FBRX account's FBRX Cloud AI.
 */
export function AiUsagePage() {
  const { data: r, reload } = useCore('ai.usage', undefined, ['settings.changed', 'account.changed']);
  if (!r) return <Page title="AI usage">{null}</Page>;
  const total = r.inputTokens + r.outputTokens;
  const month = new Date(`${r.month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const cloud = r.cloudAi;
  return (
    <Page
      title="AI usage"
      description={`What the AI read and wrote on this computer in ${month}. Only the counts are kept, never what was said.`}
      actions={
        <Button icon="refresh" onClick={reload}>
          Refresh
        </Button>
      }
    >
      <Grid cols={4}>
        <StatTile hero label="Tokens this month" value={formatTokens(total)} foot={`${formatTokens(r.inputTokens)} read · ${formatTokens(r.outputTokens)} written`} />
        <StatTile label="Tasks" value={r.runs.toLocaleString('en-US')} foot="Chats and automations the agent answered" />
        <StatTile label="Cloud AI" value={formatTokens(r.cloudTokens)} foot={r.budget ? `of ${formatTokens(r.budget)} set aside this month` : 'No monthly budget set'} />
        <StatTile label="FBRX Cloud AI left" value={cloud ? formatTokens(Math.max(0, cloud.allowance - cloud.used) + cloud.credit) : '—'} foot={cloud ? `Renews ${formatDay(cloud.renewsAt)}` : 'Sign in to an FBRX account to use it'} />
      </Grid>
      {r.budget > 0 && r.cloudTokens >= r.budget * 0.75 && (
        <Callout tone="warning" title={r.cloudTokens >= r.budget ? "This month's cloud AI budget is used" : "This month's cloud AI budget is nearly used"}>
          {r.cloudTokens >= r.budget ? 'New chats with cloud AI wait for next month or a higher budget; models on this computer still answer.' : 'The agent works sparingly now, and says so.'}{' '}
          <Button size="sm" variant="ghost" onClick={() => navigate('settings')}>
            Change the budget
          </Button>
        </Callout>
      )}
      <Card title="By day" subtitle="Tokens read and written each day this month">
        {total ? (
          <LineChart
            area
            height={180}
            series={[{ key: 'tokens', label: 'Tokens', slot: 0, points: r.days.map((d) => ({ t: new Date(`${d.day}T12:00:00`).getTime(), v: d.inputTokens + d.outputTokens })) }]}
            yFormat={formatTokens}
            xFormat={(t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          />
        ) : (
          <Empty title="Nothing yet this month">Chats and automations count here as the agent answers them.</Empty>
        )}
      </Card>
      <Grid cols={2}>
        <Card title="By model" subtitle="Each model's tokens this month; on this computer they cost nothing">
          <BarList
            items={r.models.map((m) => ({ key: `${m.providerId}/${m.model}`, label: `${m.providerName} · ${m.model}${m.cloud ? ' (cloud)' : ''}`, value: m.inputTokens + m.outputTokens }))}
            format={formatTokens}
            empty={<div className="fx-muted">No model has answered yet this month.</div>}
          />
        </Card>
        <Card title="The agent now" subtitle="What the model chats use holds, and the limits it works within">
          {r.agent ? (
            <KeyValue
              items={[
                ['Model', `${r.agent.providerName} · ${r.agent.model}${r.agent.cloud ? ' (cloud)' : ''}`],
                ['Context window', `${r.agent.windowTokens.toLocaleString('en-US')} tokens`],
                ['Longest answer', r.agent.maxOutputTokens ? `${r.agent.maxOutputTokens.toLocaleString('en-US')} tokens` : 'The model decides'],
                ['Steps per task', r.agent.maxSteps],
                ['Monthly cloud AI budget', r.budget ? `${formatTokens(r.budget)} tokens` : 'None'],
              ]}
            />
          ) : (
            <div className="fx-muted">No AI is ready: pick one in AI models.</div>
          )}
          <div className="fx-actions" style={{ marginTop: 12 }}>
            <Button size="sm" onClick={() => navigate('settings')}>
              Agent settings
            </Button>
            <Button size="sm" variant="ghost" onClick={() => navigate('runtime')}>
              AI models
            </Button>
          </div>
        </Card>
      </Grid>
      {cloud && (
        <Card title="FBRX Cloud AI" subtitle="Your FBRX account's month, counted by FBRX Command for every computer you use it on">
          <KeyValue
            items={[
              ['This month', cloud.allowance ? `${formatTokens(cloud.used)} of ${formatTokens(cloud.allowance)} tokens` : 'No monthly tokens with your edition'],
              ['Extra tokens', cloud.credit ? formatTokens(cloud.credit) : 'None'],
              ['Renews', formatDay(cloud.renewsAt)],
            ]}
          />
          {cloud.allowance > 0 && (
            <div style={{ marginTop: 10 }}>
              <Meter value={cloud.used} max={cloud.allowance} label="FBRX Cloud AI tokens used this month" />
            </div>
          )}
          {cloud.message && <p className="fx-muted">{cloud.message}</p>}
        </Card>
      )}
    </Page>
  );
}
