#
# GitHub Vault scanner — delegates to Plex Series Scanner
#
import imp
import os

_plex_series = imp.load_source(
  'plex_series_scanner',
  os.path.join(os.path.dirname(__file__), 'Plex Series Scanner.py'),
)
Scan = _plex_series.Scan
