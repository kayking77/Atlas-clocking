-- =====================================================================
--  OPTIONAL sample organizations and houses for testing.
--  These are made-up names and approximate coordinates around Attleboro,
--  Taunton and Mansfield, MA. Delete them (or skip this file) before go-live
--  and enter Atlas's real organizations and houses in the admin portal.
-- =====================================================================

insert into public.organizations (name) values
  ('Sample Org — Northbrook Community Living'),
  ('Sample Org — Harbor Path Services'),
  ('Sample Org — Riverside Supports')
on conflict (name) do nothing;

insert into public.houses (org_id, name, address, lat, lng, radius_m)
select o.id, v.name, v.address, v.lat, v.lng, v.radius_m
from (values
  ('Sample Org — Northbrook Community Living', 'Maple House',  'Sample address — Maple St, Attleboro, MA',       41.9445, -71.2856, 150),
  ('Sample Org — Northbrook Community Living', 'Oak Ridge',    'Sample address — Oak Hill Ave, Attleboro, MA',   41.9620, -71.3050, 150),
  ('Sample Org — Harbor Path Services',        'Bayview',      'Sample address — Bay St, Taunton, MA',           41.9001, -71.0898, 150),
  ('Sample Org — Harbor Path Services',        'Cedar Lane',   'Sample address — Cedar St, Taunton, MA',         41.8870, -71.1050, 150),
  ('Sample Org — Riverside Supports',          'Willow Court', 'Sample address — Willow St, Mansfield, MA',      42.0334, -71.2190, 150),
  ('Sample Org — Riverside Supports',          'Summit House', 'Sample address — Summit Ave, N. Attleborough, MA', 41.9834, -71.3320, 150)
) as v(org, name, address, lat, lng, radius_m)
join public.organizations o on o.name = v.org
on conflict (org_id, name) do nothing;
