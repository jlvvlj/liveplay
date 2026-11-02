"""Test the boundary between group separation, voice discovery and refitting."""
import argparse
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import soundfile as sf
import demucs_stems as pipeline

class StemPipelineTest(unittest.TestCase):
    def test_individual_stems_are_refit_and_preserved(self):
        for count in (0,1,2):
            with self.subTest(instruments=count), tempfile.TemporaryDirectory() as tmp:
                folder=Path(tmp);(folder/'demucs').mkdir()
                audio=np.sin(np.arange(44100)*.03).astype('float32')*.1
                source=folder/'source.wav';sf.write(source,audio,44100)
                for name in ('bass','drums','other','vocals'):
                    sf.write(folder/'demucs'/f'{name}.wav',audio,44100)
                catalog=folder/'catalog.json';catalog.write_text('[{"patch":{"family":"saw"}}]')
                calls=[]
                def fake_fit(stem,out,catalog,engine='melodic',limit=1):
                    calls.append((stem,out,engine,limit));out.mkdir(exist_ok=True)
                    base={'patch':{'family':'saw'},'notes':[{'pitch':60,'start':.1,'end':.2,'velocity':90}]}
                    if out.name=='fit-drums':return {'parts':[]}
                    if out.name=='discover-other':
                        parts=[]
                        for i in range(count):
                            p=copy.deepcopy(base);p['referenceFile']=f'voice-{i}.wav'
                            sf.write(out/p['referenceFile'],audio/(i+2),44100)
                            parts.append(p)
                        return {'parts':parts,'analysis':{}}
                    return {'parts':[copy.deepcopy(base)],'analysis':{}}
                with patch.object(pipeline,'fit',side_effect=fake_fit):
                    pipeline.main(argparse.Namespace(input=source,output=folder,catalog=catalog))
                result=json.loads((folder/'result.json').read_text())
                self.assertEqual(len(result['parts']),1+count)
                self.assertEqual([p['name'] for p in result['parts']],['Bass']+[f'Synth {i+1}' for i in range(count)])
                self.assertTrue(all(c[0]!=source for c in calls),'No discovery on full mix')
                self.assertEqual(calls[2][3],12)
                for i,part in enumerate(result['parts'][1:]):
                    expected=folder/'demucs/other.wav' if count==1 else folder/'discover-other'/f'voice-{i}.wav'
                    self.assertEqual(calls[3+i][0],expected)
                    self.assertEqual((folder/part['referenceFile']).read_bytes(),expected.read_bytes())
                    self.assertTrue(part['referenceWaveform'])
                if not count:self.assertTrue(any('absent from the rebuilt' in w for w in result['analysis']['warnings']))

    def test_misaligned_demucs_outputs_fail_before_fitting(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);(folder/'demucs').mkdir()
            sf.write(folder/'source.wav',np.zeros(44100),44100)
            sf.write(folder/'demucs/bass.wav',np.zeros(22050),44100)
            (folder/'catalog.json').write_text('[]')
            with patch.object(pipeline,'fit') as fit:
                with self.assertRaisesRegex(ValueError,'misaligned bass'):
                    pipeline.main(argparse.Namespace(input=folder/'source.wav',output=folder,catalog=folder/'catalog.json'))
                fit.assert_not_called()

if __name__=='__main__':unittest.main()
