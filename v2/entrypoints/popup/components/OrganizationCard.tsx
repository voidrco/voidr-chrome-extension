import React, { useEffect, useMemo, useState } from 'react';
import { testPlanningService } from '../../../src/services/testPlanningService';

export default function OrganizationCard() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = tab?.url || '';
        const ctx = await testPlanningService.initializeForCurrentPage?.(url);
        if (!mounted) return;
        setData(ctx);
      } catch (e: any) {
        if (!mounted) return;
        setError(e?.message || 'Failed to load organization');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const orgName = useMemo(() => {
    if (!data?.application) return null;
    return data.application.name;
  }, [data]);

  return (
    <div style={{ border: '1px solid #333', margin: '0 8px 8px', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8 }}>
        <img src="/assets/logo-light.svg" alt="Voidr Logo" style={{ height: 18 }} />
        <div style={{ fontWeight: 600 }}>Organization</div>
      </div>
      <div style={{ padding: 8, borderTop: '1px solid #333' }}>
        {loading && <div>Loading...</div>}
        {error && <div style={{ color: '#e66' }}>{error}</div>}
        {!loading && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div><strong>Application:</strong> {orgName || 'Not found for this URL'}</div>
            {data?.testPlan && (
              <div><strong>Test Plan:</strong> {data.testPlan.name}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
