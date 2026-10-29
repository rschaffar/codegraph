/** Synthetic, hand-authored fixtures. Nothing here is read from an index. */
export interface DemoMethod {
  name: string;
  line: number;
  code: string[];
}

export interface DemoComponent {
  id: string;
  name: string;
  folder: string;
  purpose: string;
  position: { x: number; y: number };
  methods: DemoMethod[];
}

export interface DemoCall {
  id: string;
  source: string;
  sourceMethod: string;
  target: string;
  targetMethod: string;
  line: number;
  via?: string;
}

function method(name: string, line: number, code: string): DemoMethod {
  return { name, line, code: code.trim().split('\n') };
}

export const demoComponents: DemoComponent[] = [
  {
    id: 'endpoint', name: 'UpdateEndpoint', folder: 'Demo.Api',
    purpose: 'Accepts an explicit update request.', position: { x: 0, y: 30 },
    methods: [method('Update', 18, `public async Task Update(string version)
{
    await _coordinator.Apply(version);
}`)],
  },
  {
    id: 'scheduler', name: 'RefreshScheduler', folder: 'Demo.Hosting',
    purpose: 'Checks for new data on a timer.', position: { x: 0, y: 235 },
    methods: [method('Tick', 24, `public async Task Tick(CancellationToken token)
{
    await _coordinator.Refresh(token);
}`)],
  },
  {
    id: 'coordinator', name: 'RefreshCoordinator', folder: 'Demo.Refresh',
    purpose: 'Coordinates validation, publication and selection.', position: { x: 350, y: 180 },
    methods: [
      method('Refresh', 42, `public async Task Refresh(CancellationToken token)
{
    var xml = await _source.Fetch(token);
    var candidate = _factory.Build(xml);
    await _publisher.Publish(candidate);
    _state.Install(candidate);
    _audit.Record("refresh", this);
}`),
      method('Apply', 58, `public async Task Apply(string version)
{
    var xml = await _source.FetchVersion(version);
    var candidate = _factory.Build(xml);
    _state.Install(candidate);
}`),
      method('Report', 70, `public Snapshot Report()
{
    return _state.Read();
}`),
    ],
  },
  {
    id: 'factory', name: 'CandidateFactory', folder: 'Demo.Refresh',
    purpose: 'Builds a complete candidate from authenticated data.', position: { x: 700, y: 0 },
    methods: [method('Build', 32, `public Candidate Build(string xml)
{
    var parsed = _loader.Parse(xml);
    return new Candidate(parsed.Version, parsed.Digests);
}`)],
  },
  {
    id: 'state', name: 'SnapshotStore', folder: 'Demo.Policy',
    purpose: 'Owns the active in-memory selection.', position: { x: 700, y: 235 },
    methods: [
      method('Install', 20, `public void Install(Snapshot next)
{
    Interlocked.Exchange(ref _current, next);
}`),
      method('Read', 26, `public Snapshot Read()
{
    return Volatile.Read(ref _current);
}`),
    ],
  },
  {
    id: 'publisher', name: 'FilePublisher', folder: 'Demo.Storage',
    purpose: 'Publishes the SDK files, independently of memory.', position: { x: 700, y: 470 },
    methods: [method('Publish', 38, `public async Task Publish(Candidate candidate)
{
    await _disk.Replace(candidate.Xml);
    await _disk.ReplaceAllowance(candidate.Digests);
}`)],
  },
  {
    id: 'loader', name: 'SignedDataLoader', folder: 'Demo.Core',
    purpose: 'Authenticates and parses data behind IDataLoader.', position: { x: 1050, y: 0 },
    methods: [method('Parse', 41, `public ParsedData Parse(string xml)
{
    var document = LoadXml(xml);
    ValidateSignature(document);
    return ParseDigests(document);
}`)],
  },
  {
    id: 'source', name: 'RemoteSource', folder: 'Demo.Transport',
    purpose: 'Fetches untrusted text from the upstream API.', position: { x: 1050, y: 235 },
    methods: [
      method('Fetch', 15, `public Task<string> Fetch(CancellationToken token)
{
    return _client.GetLatest(token);
}`),
      method('FetchVersion', 21, `public Task<string> FetchVersion(string version)
{
    return _client.GetVersion(version);
}`),
    ],
  },
  {
    id: 'policy', name: 'ClientPolicy', folder: 'Demo.Policy',
    purpose: 'Evaluates a client against the active snapshot.', position: { x: 350, y: 470 },
    methods: [method('Evaluate', 28, `public bool Evaluate(byte[] digest)
{
    var snapshot = _state.Read();
    return snapshot.Contains(digest);
}`)],
  },
  {
    id: 'audit', name: 'AuditTrail', folder: 'Demo.Observability',
    purpose: 'Records a summary; its callback creates a sample cycle.', position: { x: 0, y: 470 },
    methods: [method('Record', 16, `public void Record(string operation, RefreshCoordinator owner)
{
    var snapshot = owner.Report();
    _log.Write(operation, snapshot.Version);
}`)],
  },
];

const calls: Omit<DemoCall, 'id'>[] = [
  { source: 'endpoint', sourceMethod: 'Update', target: 'coordinator', targetMethod: 'Apply', line: 20 },
  { source: 'scheduler', sourceMethod: 'Tick', target: 'coordinator', targetMethod: 'Refresh', line: 26 },
  { source: 'coordinator', sourceMethod: 'Refresh', target: 'factory', targetMethod: 'Build', line: 45 },
  { source: 'coordinator', sourceMethod: 'Apply', target: 'factory', targetMethod: 'Build', line: 61 },
  { source: 'coordinator', sourceMethod: 'Refresh', target: 'state', targetMethod: 'Install', line: 47 },
  { source: 'coordinator', sourceMethod: 'Apply', target: 'state', targetMethod: 'Install', line: 62 },
  { source: 'coordinator', sourceMethod: 'Report', target: 'state', targetMethod: 'Read', line: 72 },
  { source: 'coordinator', sourceMethod: 'Refresh', target: 'publisher', targetMethod: 'Publish', line: 46 },
  { source: 'coordinator', sourceMethod: 'Refresh', target: 'source', targetMethod: 'Fetch', line: 44 },
  { source: 'coordinator', sourceMethod: 'Apply', target: 'source', targetMethod: 'FetchVersion', line: 60 },
  { source: 'factory', sourceMethod: 'Build', target: 'loader', targetMethod: 'Parse', line: 34, via: 'Sample bridge via IDataLoader.Parse → SignedDataLoader.Parse' },
  { source: 'policy', sourceMethod: 'Evaluate', target: 'state', targetMethod: 'Read', line: 30 },
  { source: 'coordinator', sourceMethod: 'Refresh', target: 'audit', targetMethod: 'Record', line: 48 },
  { source: 'audit', sourceMethod: 'Record', target: 'coordinator', targetMethod: 'Report', line: 18 },
];

export const demoCalls: DemoCall[] = calls.map((call, index) => ({ ...call, id: `sample-call-${index}` }));
export const initialFocus = ['coordinator', 'factory', 'state'];

export function component(id: string): DemoComponent {
  const found = demoComponents.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown demo component: ${id}`);
  return found;
}

export function sourceMethod(componentId: string, name: string): DemoMethod {
  const found = component(componentId).methods.find((item) => item.name === name);
  if (!found) throw new Error(`Unknown demo method: ${componentId}.${name}`);
  return found;
}
