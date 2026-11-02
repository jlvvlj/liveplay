"""No-network tests of HF job recovery and cancellation; no GPU submissions."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec=importlib.util.spec_from_file_location('hf_client',Path(__file__).resolve().parents[1]/'hf/client.py')
client=importlib.util.module_from_spec(spec);spec.loader.exec_module(client)

class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.request=self.root/'request.json';self.request.write_text(json.dumps({'targets':[{'name':'Bass'}]}))
        self.args=SimpleNamespace(check=False,cancel=False,input=None,request=self.request,output=self.root)
        self.state={'id':'existing-job','namespace':'test','runId':'attempt','results':'hf://buckets/test/private/attempt/output','url':'https://huggingface.co/jobs/test/existing-job'}
        client.save(self.root/'hf-job.json',self.state)
        self.api=Mock()
        self.api.inspect_job.return_value=SimpleNamespace(status=SimpleNamespace(stage='COMPLETED'))
    def sync(self,*args,**kwargs):
        out=self.root/'hf-output/stems';out.mkdir(parents=True,exist_ok=True)
        (out/'run.json').write_text(json.dumps({'status':'finished','jobs':[{'id':'instrument-1'}]}))
    def run_client(self):
        with patch.object(client,'credentials',return_value='test-only-placeholder'),patch.object(client,'HfApi',return_value=self.api),patch.object(client,'sync_bucket',side_effect=self.sync),patch.object(client,'event'),patch.object(client.signal,'signal'):
            client.main(self.args)
    def test_resume_downloads_same_completed_job_without_submitting(self):
        self.run_client();self.api.run_job.assert_not_called()
        self.api.inspect_job.assert_called_with(job_id='existing-job',namespace='test')
    def test_unknown_submission_recovers_by_unique_attempt_label(self):
        self.state.pop('id');client.save(self.root/'hf-job.json',self.state)
        self.api.list_jobs.return_value=[SimpleNamespace(id='recovered',url='https://huggingface.co/jobs/test/recovered',labels={'run-id':'attempt'})]
        self.run_client();self.api.run_job.assert_not_called()
        self.assertEqual(json.loads((self.root/'hf-job.json').read_text())['id'],'recovered')
    def test_ambiguous_submission_does_not_launch_another_paid_job(self):
        self.state.pop('id');client.save(self.root/'hf-job.json',self.state)
        self.api.list_jobs.return_value=[]
        with self.assertRaisesRegex(ValueError,'could not be confirmed'):self.run_client()
        self.api.run_job.assert_not_called()
    def test_cancel_reaches_existing_remote_job(self):
        self.args.cancel=True;self.api.inspect_job.return_value.status.stage='RUNNING'
        self.run_client();self.api.cancel_job.assert_called_once_with(job_id='existing-job',namespace='test')
        self.api.run_job.assert_not_called()
    def test_remote_failure_is_not_relabelled_as_success(self):
        self.api.inspect_job.return_value.status.stage='ERROR'
        with self.assertRaisesRegex(ValueError,'job error'):self.run_client()
        self.api.run_job.assert_not_called()

if __name__=='__main__':unittest.main()
