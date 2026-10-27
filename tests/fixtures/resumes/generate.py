"""Generate deterministic fictional PDF resumes for local extraction tests."""
from pathlib import Path
from textwrap import wrap
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.pagesizes import A4
root = Path(__file__).resolve().parent
profiles = [
 ('backend.pdf', 'Alex Example', 'Backend Engineer', 'JavaScript, Laravel, MySQL and Git'),
 ('quality.pdf', 'Blair Example', 'Quality Engineer', 'Playwright, SQL, API testing and release verification'),
 ('network.pdf', 'Casey Example', 'Network Engineer', 'Linux, routing, monitoring and incident response'),
 ('operations.pdf', 'Drew Example', 'Operations Coordinator', 'Microsoft Office, scheduling, purchasing and reporting'),
]
for filename, name, role, skills in profiles:
 c = Canvas(str(root / filename), pagesize=A4, pageCompression=0, invariant=1)
 c.setTitle('Fictional recruitment test resume: ' + role)
 c.setAuthor('ERP recruitment test fixtures')
 y = 790
 def line(text, bold=False):
  global y
  if y < 55:
   c.showPage(); y = 790
  c.setFont('Helvetica-Bold' if bold else 'Helvetica', 10)
  c.drawString(45, y, text); y -= 14
 def paragraph(text):
  for part in wrap(text, 100): line(part)
  line('')
 line(name, True); line(role, True)
 paragraph('Fictional test applicant. Contact: applicant@example.invalid. No real person or employment history is represented by this document.')
 paragraph('Summary: A practical professional with experience in ' + skills + '. Works with colleagues to clarify requirements, document decisions, improve reliability and deliver measurable results. Maintains clear records and reviews changes before release.')
 for index in range(1, 7):
  line('Project ' + str(index) + ': ' + role + ' delivery and improvement', True)
  paragraph('At Example Organization, planned the work with a small delivery team and recorded the acceptance criteria. Used ' + skills + ' to implement the agreed changes. Investigated inconsistent results, reproduced reported defects and tested the corrected behavior with representative examples.')
  paragraph('Reviewed work with stakeholders, recorded outstanding dependencies and prepared an operating guide. Coordinated scheduled activities across teams, kept progress visible and followed up on unresolved issues. The team completed the agreed scope and retained evidence of functional checks and peer review.')
 line('Education and development', True)
 paragraph('Bachelor-level technical education at Fictional Institute. Completed workshops in communication, data quality, security awareness and team collaboration. Continued learning through practical projects, documentation and structured feedback.')
 line('Availability and interests', True)
 paragraph('Available for a full-time role with an agreed notice period. Interested in improving everyday processes, sharing knowledge with colleagues and maintaining reliable services. References are fictional and are not available for contact.')
 c.save()
