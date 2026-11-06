
// Added by the Melodics port's build.sh: brings every clone up to date and
// calls `visit` on every processor, recursively
namespace mopo {
  void ProcessorRouter::visitAll(void (*visit)(Processor*)) {
    updateAllProcessors();
    for (Processor* processor : local_order_) {
      if (visit)
        visit(processor);
      ProcessorRouter* router = dynamic_cast<ProcessorRouter*>(processor);
      if (router)
        router->visitAll(visit);
    }
  }
} // namespace mopo
