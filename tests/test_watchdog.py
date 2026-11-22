import importlib.util
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('guard', Path(__file__).parents[1]/'lib/colab-remote/watchdog.py')
guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
class GuardTests(unittest.TestCase):
    def test_idle_five_minutes(self):
        c={'busy':False,'last_activity':1000,'idle_minutes':5}
        self.assertEqual(guard.should_release(c,None,1299),(False,False))
        self.assertEqual(guard.should_release(c,None,1300),(True,False))
    def test_busy_uses_hard_limit(self):
        c={'busy':True,'deadline':2000,'started':1000,'idle_minutes':5}
        self.assertEqual(guard.should_release(c,None,1400),(False,False))
        self.assertEqual(guard.should_release(c,None,2001),(True,False))
    def test_selected_runtime_end_applies_even_during_generation(self):
        c={'busy':True,'deadline':3000,'runtime_deadline':2000,'started':1000,'idle_minutes':15}
        self.assertEqual(guard.should_release(c,None,1999),(False,False))
        self.assertEqual(guard.should_release(c,None,2000),(True,False))
    def test_stale_batch_does_not_stop_new_work(self):
        c={'busy':True,'deadline':3000,'started':2000,'idle_minutes':5}
        self.assertEqual(guard.should_release(c,{'done':True,'started':1000},2200),(False,False))
    def test_completion_starts_fresh_idle_period(self):
        c={'busy':True,'deadline':3000,'started':1000,'idle_minutes':5}
        self.assertEqual(guard.should_release(c,{'done':True,'started':1000},1500),(False,True))
        self.assertEqual(c['last_activity'],1500)
        self.assertFalse(c['busy'])
    def test_failure_and_zero_idle_stop(self):
        for idle,error in [(0,None),(5,'model unavailable')]:
            c={'busy':True,'deadline':3000,'started':1000,'idle_minutes':idle}
            self.assertEqual(guard.should_release(c,{'done':True,'started':1000,'error':error},1500),(True,True))
if __name__=='__main__': unittest.main()
