export interface DemoSymbol {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  folder: string;
  file: string;
  line: number;
  purpose: string;
  ownerId?: string;
  code?: string[];
}
export interface DemoRelation {
  id: string;
  source: string;
  target: string;
  kind: string;
  file: string;
  line: number;
  via?: string;
}

// All names, declarations and evidence below are hand-authored synthetic data.
// This is neither an extraction fixture nor a claim of runtime behaviour.
const symbols: DemoSymbol[] = [];
function define(id: string, kind: string, name: string, folder: string, purpose: string,
  code?: string, ownerId?: string, line = 1): DemoSymbol {
  const owner = symbols.find((item) => item.id === ownerId);
  const item: DemoSymbol = {
    id, kind, name, folder, purpose, ownerId, line,
    qualifiedName: owner && !['file', 'module', 'namespace'].includes(owner.kind) ? `${owner.qualifiedName}.${name}` : kind === 'namespace' ? name : `${folder}.${name}`,
    file: owner?.file ?? `${folder.replaceAll('.', '/')}/${kind === 'file' ? name : `${name.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}.cs`}`,
    code: code?.trim().split('\n'),
  };
  symbols.push(item);
  return item;
}

define('file', 'file', 'Refresh.cs', 'Demo.Refresh', 'A file can be an independently selected graph entity.', '// Synthetic file outline; expand Members to inspect its contents.');
define('module', 'module', 'RefreshModule', 'Demo', 'An indexed module, not an invented class.', '// Synthetic module declaration');
define('namespace', 'namespace', 'Demo.Policy', 'Demo.Policy', 'A scope with types and values.', 'namespace Demo.Policy;');
define('coordinator', 'class', 'RefreshCoordinator', 'Demo.Refresh', 'Coordinates validation, publication and selection.', '[Tracked]\npublic class RefreshCoordinator : RefreshBase { /* expand members */ }', 'file', 30);
define('factory', 'class', 'CandidateFactory', 'Demo.Refresh', 'Builds a candidate from authenticated data.', 'public class CandidateFactory { /* expand members */ }', 'file', 10);
define('state', 'class', 'SnapshotStore', 'Demo.Policy', 'Owns the active in-memory selection.', 'public class SnapshotStore { /* expand members */ }', 'namespace', 10);
define('publisher', 'class', 'FilePublisher', 'Demo.Storage', 'Publishes files independently of memory.', 'public class FilePublisher { /* expand members */ }');
define('loader', 'class', 'SignedDataLoader', 'Demo.Core', 'An implementation, not a guaranteed interface-dispatch target.', 'public class SignedDataLoader : IDataLoader { /* expand members */ }');
define('source', 'class', 'RemoteSource', 'Demo.Transport', 'Fetches untrusted text from an upstream API.', 'public class RemoteSource { /* expand members */ }');
define('audit', 'class', 'AuditTrail', 'Demo.Observability', 'Its callback creates a marked sample cycle.', 'public class AuditTrail { /* expand members */ }');
define('policy', 'class', 'ClientPolicy', 'Demo.Policy', 'Evaluates a client against the active snapshot.', 'public class ClientPolicy { /* expand members */ }', 'namespace', 20);
define('base', 'class', 'RefreshBase', 'Demo.Refresh', 'A base type for the inheritance example.', 'public class RefreshBase { /* expand members */ }');
define('contract', 'interface', 'IDataLoader', 'Demo.Core', 'Calls through this boundary do not establish runtime dispatch.', 'public interface IDataLoader { ParsedData Parse(string xml); }');
define('candidate', 'struct', 'Candidate', 'Demo.Refresh', 'A value type constructed and returned by Build.', 'public readonly record struct Candidate(string Version, byte[][] Digests);');
define('status', 'enum', 'RefreshStatus', 'Demo.Policy', 'An enum is a type with expandable enum members.', 'public enum RefreshStatus { Ready, Failed }', 'namespace', 40);
define('ready', 'enum_member', 'Ready', 'Demo.Policy', 'An enum member can be pinned on its own.', 'Ready = 0', 'status', 40);
define('alias', 'type_alias', 'ParsedSnapshot', 'Demo.Core', 'A named type alias, not a runtime object.', 'using ParsedSnapshot = ParsedData;');
define('trait', 'trait', 'Refreshable', 'Demo.Contracts', 'Trait metadata example; no source body is supplied.');
define('protocol', 'protocol', 'RefreshDelegate', 'Demo.Contracts', 'Protocol metadata example; no source body is supplied.');
define('union', 'union', 'RefreshOutcome', 'Demo.Native', 'A union declaration from a different source language.', 'union RefreshOutcome { int code; double duration; };');
define('constant', 'constant', 'MaxAge', 'Demo.Policy', 'A constant is selectable without selecting its namespace.', 'const int MaxAge = 60;', 'namespace', 50);
define('function', 'function', 'NormalizeVersion', 'Demo.Utilities', 'A free function has no fabricated owning class.', 'string NormalizeVersion(string value) => value.Trim();');
define('route', 'route', 'POST /updates', 'Demo.Api', 'A synthetic route points to a handler; it has no method body.', 'app.MapPost("/updates", coordinator.Apply);');
define('dashboard', 'component', 'UpdateDashboard', 'Demo.Web', 'An indexed UI component with a navigation relationship.', 'function UpdateDashboard() { return <Link href="/updates">Update</Link>; }');
define('import', 'import', 'RefreshModule import', 'Demo.Api', 'An import binding can be inspected independently.', 'import { CandidateFactory } from "./refresh";');
define('export', 'export', 'CandidateFactory export', 'Demo.Refresh', 'An export binding with its own identity.', 'export { CandidateFactory };', 'module');
define('tracking', 'class', 'TrackedAttribute', 'Demo.Observability', 'Annotation target for the decoration example.', 'public class TrackedAttribute : Attribute {}');
define('unknown', 'future_kind', 'FutureSymbol', 'Demo.Future', 'Fallback example: an unrecognised kind remains selectable.');

define('coordinator.Refresh', 'method', 'Refresh', 'Demo.Refresh', 'Builds, publishes and installs a snapshot.', `public override async Task Refresh(CancellationToken token)
{
    var xml = await _source.Fetch(token);
    var candidate = _factory.Build(xml);
    await _publisher.Publish(candidate);
    _state.Install(candidate);
    _audit.Record("refresh", this);
}`, 'coordinator', 42);
define('coordinator.Apply', 'method', 'Apply', 'Demo.Refresh', 'Applies one requested version.', `public async Task Apply(string version)
{
    var xml = await _source.FetchVersion(version);
    var candidate = _factory.Build(xml);
    _state.Install(candidate);
}`, 'coordinator', 58);
define('coordinator.Report', 'method', 'Report', 'Demo.Refresh', 'Reads the active snapshot.', `public Snapshot Report()
{
    return _state.Read();
}`, 'coordinator', 70);
define('factory.Build', 'method', 'Build', 'Demo.Refresh', 'Creates and returns a candidate through an interface boundary.', `public Candidate Build(string xml)
{
    var parsed = _loader.Parse(xml);
    return new Candidate(parsed.Version, parsed.Digests);
}`, 'factory', 32);
define('state.Install', 'method', 'Install', 'Demo.Policy', 'Replaces the current selection.', 'public void Install(Snapshot next) { Interlocked.Exchange(ref _current, next); }', 'state', 20);
define('state.Read', 'method', 'Read', 'Demo.Policy', 'Reads the current selection.', 'public Snapshot Read() { return Volatile.Read(ref _current); }', 'state', 26);
define('publisher.Publish', 'method', 'Publish', 'Demo.Storage', 'Publishes a candidate.', 'public Task Publish(Candidate candidate) { return _disk.Replace(candidate.Xml); }', 'publisher', 38);
define('source.Fetch', 'method', 'Fetch', 'Demo.Transport', 'Fetches the newest text.', 'public Task<string> Fetch(CancellationToken token) => _client.GetLatest(token);', 'source', 15);
define('source.FetchVersion', 'method', 'FetchVersion', 'Demo.Transport', 'Fetches one version.', 'public Task<string> FetchVersion(string version) => _client.GetVersion(version);', 'source', 21);
define('contract.Parse', 'method', 'Parse', 'Demo.Core', 'The declared interface entry point.', 'ParsedData Parse(string xml);', 'contract', 12);
define('loader.Parse', 'method', 'Parse', 'Demo.Core', 'A possible implementation, separately inspectable.', 'public ParsedData Parse(string xml) { return ParseDigests(ValidateSignature(xml)); }', 'loader', 41);
define('base.Refresh', 'method', 'Refresh', 'Demo.Refresh', 'The inherited member overridden by RefreshCoordinator.', 'public virtual Task Refresh(CancellationToken token) => Task.CompletedTask;', 'base', 15);
define('audit.Record', 'method', 'Record', 'Demo.Observability', 'Callback evidence is labelled rather than asserted as static dispatch.', `public void Record(string operation, RefreshCoordinator owner)
{
    var snapshot = owner.Report();
    _log.Write(operation, snapshot.Version);
}`, 'audit', 16);
define('policy.Evaluate', 'method', 'Evaluate', 'Demo.Policy', 'Uses both a callable and a value.', 'public bool Evaluate(byte[] digest) => _state.Read().Age < MaxAge;', 'policy', 28);
define('field', 'field', '_state', 'Demo.Refresh', 'A typed field, not a call to SnapshotStore.', 'private SnapshotStore _state;', 'coordinator', 35);
define('property', 'property', 'Status', 'Demo.Policy', 'A property can have type and reference relationships.', 'public RefreshStatus Status { get; } = RefreshStatus.Ready;', 'state', 15);
define('variable', 'variable', 'parsed', 'Demo.Refresh', 'A local variable is independently inspectable.', 'var parsed = _loader.Parse(xml);', 'factory.Build', 34);
define('parameter', 'parameter', 'xml', 'Demo.Refresh', 'A parameter belongs to a method, not directly to its class.', 'string xml', 'factory.Build', 32);

export const demoSymbols: readonly DemoSymbol[] = symbols;
export function symbol(id: string): DemoSymbol {
  const found = demoSymbols.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown sample symbol: ${id}`);
  return found;
}
export function children(id: string): DemoSymbol[] {
  return demoSymbols.filter((item) => item.ownerId === id).sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

const relations: DemoRelation[] = [];
function connect(source: string, target: string, kind: string, line = symbol(source).line, via?: string) {
  relations.push({ id: `sample-edge-${relations.length}`, source, target, kind, line, file: symbol(source).file, via });
}
for (const item of demoSymbols) if (item.ownerId) connect(item.ownerId, item.id, 'contains', item.line);
connect('coordinator.Refresh', 'factory.Build', 'calls', 45);
connect('coordinator.Apply', 'factory.Build', 'calls', 61);
connect('coordinator.Refresh', 'state.Install', 'calls', 47);
connect('coordinator.Apply', 'state.Install', 'calls', 62);
connect('coordinator.Report', 'state.Read', 'calls', 72);
connect('coordinator.Refresh', 'publisher.Publish', 'calls', 46);
connect('coordinator.Refresh', 'source.Fetch', 'calls', 44);
connect('coordinator.Apply', 'source.FetchVersion', 'calls', 60);
connect('factory.Build', 'contract.Parse', 'calls', 34);
connect('coordinator.Refresh', 'audit.Record', 'calls', 48);
connect('audit.Record', 'coordinator.Report', 'calls', 18, 'Hand-authored callback example; runtime target is not proven');
connect('policy.Evaluate', 'state.Read', 'calls', 28);
connect('factory.Build', 'candidate', 'instantiates', 35);
connect('factory.Build', 'candidate', 'returns', 32);
connect('coordinator', 'base', 'extends', 31);
connect('coordinator.Refresh', 'base.Refresh', 'overrides', 42);
connect('loader', 'contract', 'implements');
connect('field', 'state', 'type_of');
connect('property', 'status', 'type_of');
connect('property', 'ready', 'references');
connect('variable', 'alias', 'type_of');
connect('policy.Evaluate', 'constant', 'references', 28);
connect('file', 'module', 'imports');
connect('module', 'factory', 'exports');
connect('export', 'factory', 'exports');
connect('import', 'module', 'imports');
connect('coordinator', 'tracking', 'decorates', 30);
connect('dashboard', 'route', 'navigates');
connect('route', 'coordinator.Apply', 'references');
// Demonstrates safe presentation of an edge kind added by a future engine.
connect('unknown', 'trait', 'future_relation');
export const demoRelations: readonly DemoRelation[] = relations;
export const initialSelection = ['coordinator', 'factory', 'state'];
