
// Added by the Melodics port's build.sh: every voice's processors too
namespace mopo {
  void VoiceHandler::visitAll(void (*visit)(Processor*)) {
    ProcessorRouter::visitAll(visit);
    global_router_.visitAll(visit);
    voice_router_.visitAll(visit);
    for (Voice* voice : all_voices_) {
      ProcessorRouter* router = dynamic_cast<ProcessorRouter*>(voice->processor());
      if (router)
        router->visitAll(visit);
    }
  }
} // namespace mopo
