// Non-secret defaults required only to construct SDK clients during tests.
// Individual suites replace clients with mocks and must never contact this URL.
process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';