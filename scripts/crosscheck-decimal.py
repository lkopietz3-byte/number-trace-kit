# Dev-only reference for scripts/crosscheck.mjs and test/decimal-crosscheck.test.ts. Standard library only (decimal, fractions).
# Reads a JSON list of cases on stdin and writes the expected answers as a JSON list on stdout. Run it with `python3 -I`.
# It never reads the kit's output: it answers from the cases alone.
#
#   R  round |v| to s decimals (s may be negative) half-up or half-even           -> {"e": "<integer count of 10^-s units>"}
#   A  exact sum or difference of two decimals                                      -> {"e": "<decimal>"}
#   Q  exact quotient, product, percent-of or percent-change of two decimals        -> {"e": "<p>/<q> in lowest terms"}
#   T  one evidence number v and the ways of writing it with p decimals             -> {"ys": [{"y": "...", "expect": "rounded"|"untraced"}]}
#   D  two evidence numbers and one derivation: the values the documented rule accepts, the reverse direction, and near misses
#                                                                                   -> {"ys": [{"y": "...", "expect": "derived"|"unknown"|"untraced"}]}
import json
import sys
from decimal import Decimal, ROUND_HALF_EVEN, ROUND_HALF_UP, getcontext
from fractions import Fraction

getcontext().prec = 1200


def dec(s):
    return Decimal(s)


def frac_of(s):
    return Fraction(Decimal(s))


def round_to(x, p, mode):
    """x: Fraction or Decimal. p decimals (may be negative). Returns a Decimal."""
    d = x if isinstance(x, Decimal) else Decimal(x.numerator) / Decimal(x.denominator)
    q = Decimal(1).scaleb(-p)
    return d.quantize(q, rounding=ROUND_HALF_UP if mode == 'u' else ROUND_HALF_EVEN)


def fixed(d, p):
    """Fixed-notation text with exactly p fraction digits (p >= 0)."""
    s = format(d.quantize(Decimal(1).scaleb(-p)), 'f')
    return s


def scale_of(s):
    return len(s.split('.')[1]) if '.' in s else 0


def sig_digits(text):
    digits = text.replace('-', '').replace('.', '').replace('%', '').lstrip('0')
    return len(digits.rstrip('0')) if digits else 0


def year_like(text):
    t = text.replace('-', '')
    return t.isdigit() and 1900 <= int(t) <= 2100 and len(t) == 4


def direct_values(a, b, p):
    """What a plain match could produce: an evidence number, or one rounded to 0..p decimals either way."""
    out = set()
    for s in (a, b):
        out.add(fixed(dec(s), scale_of(s)))
        out.add(str(Decimal(s).normalize()))
        for q in range(0, p + 1):
            for m in 'ue':
                out.add(fixed(round_to(dec(s), q, m), q))
    return out


def case_R(c):
    v, s, m = dec(c['v']), c['s'], c['m']
    r = round_to(abs(v), s, m)
    return {'e': str(int(r.scaleb(s)))}


def case_A(c):
    a, b = dec(c['a']), dec(c['b'])
    r = a + b if c['op'] == '+' else a - b
    p = max(scale_of(c['a']), scale_of(c['b']))
    return {'e': '0' if r == 0 else fixed(r, p)}


def case_Q(c):
    a, b = frac_of(c['a']), frac_of(c['b'])
    op = c['op']
    if op == '/':
        r = a / b
    elif op == '*':
        r = a * b
    elif op == 'pct':
        r = a / b * 100
    else:  # percent change from a to b
        r = (b - a) / a * 100
    return {'e': '%d/%d' % (r.numerator, r.denominator)}


def coarse_rounding_of(v, y):
    """True when the whole number y that ends in zeros is a rounding of v at tens, hundreds, ... below v's leading digit
    (README rule 9): the kit cannot tell it from a spelled-out value, so it says unknown, not untraced."""
    t = y.replace('-', '')
    if '.' in t or not t.endswith('0') or t.strip('0') == '':
        return False
    intdigits = len(str(int(abs(v))))
    for k in range(1, intdigits):
        for m in 'ue':
            if round_to(abs(v), -k, m) == abs(Decimal(y)):
                return True
    return False


def case_T(c):
    v, p = dec(c['v']), c['p']
    up, ev = fixed(round_to(v, p, 'u'), p), fixed(round_to(v, p, 'e'), p)
    trunc = fixed(v.quantize(Decimal(1).scaleb(-p), rounding='ROUND_DOWN'), p)
    ok = {up, ev}
    ys = []
    for y in sorted(ok):
        ys.append({'y': y, 'expect': 'rounded'})
    ulp = Decimal(1).scaleb(-p)
    near = set()
    for base in (round_to(v, p, 'u'), round_to(v, p, 'e')):
        near.add(fixed(base + ulp, p))
        near.add(fixed(base - ulp, p))
    near.add(trunc)
    for y in sorted(near - ok):
        ys.append({'y': y, 'expect': 'untraced'})
    # drop anything that reads as zero or a year, or that is the evidence number itself
    keep = []
    for e in ys:
        t = e['y']
        if Decimal(t) == 0 or year_like(t) or Decimal(t) == v:
            continue
        if e['expect'] == 'untraced' and coarse_rounding_of(v, t):
            e['expect'] = 'unknown'
        keep.append(e)
    return {'ys': keep}


def derived_values(op, a, b):
    """Exact Fractions: primary value(s) and the reverse-direction value, per the documented rule."""
    A, B = frac_of(a), frac_of(b)
    if op == 'sum':
        return [A + B], []
    if op == 'difference':
        return [B - A, abs(A - B)], []
    if op == 'ratio':
        return [A / B], [B / A]
    if op == 'percent-change':
        return [(B - A) / A * 100, abs((B - A) / A * 100)], [(A - B) / B * 100, abs((A - B) / B * 100)]
    if op == 'percent-of':
        return [A / B * 100], [B / A * 100]
    if op == 'average':
        return [(A + B) / 2], []
    if op == 'product':
        return [A * B], []
    raise ValueError(op)


def case_D(c):
    op, a, b, p = c['op'], c['a'], c['b'], c['p']
    pct = op in ('percent-change', 'percent-of')
    exact_ops = op in ('sum', 'difference')
    prim, rev = derived_values(op, a, b)
    places = max(scale_of(a), scale_of(b)) if exact_ops else p
    suffix = '%' if pct else ''

    def show(fr, mode):
        d = Decimal(fr.numerator) / Decimal(fr.denominator)
        return fixed(round_to(d, places, mode), places)

    modes = ['u'] if exact_ops else ['u', 'e']
    prim_set, rev_set = set(), set()
    for fr in prim:
        for m in modes:
            prim_set.add(show(fr, m))
    for fr in rev:
        for m in modes:
            rev_set.add(show(fr, m))
    if exact_ops:
        # only a number that equals the exact result is accepted (roundSums is off)
        for fr in prim:
            d = Decimal(fr.numerator) / Decimal(fr.denominator)
            if d != round_to(d, places, 'u'):
                prim_set.discard(show(fr, 'u'))
    direct = direct_values(a, b, places)
    ulp = Decimal(1).scaleb(-places)
    union = prim_set | rev_set
    ys = []
    for y in sorted(prim_set):
        ys.append((y, 'derived'))
    for y in sorted(rev_set - prim_set):
        ys.append((y, 'unknown'))
    near = set()
    for y in prim_set | rev_set:
        near.add(fixed(Decimal(y) + ulp, places))
        near.add(fixed(Decimal(y) - ulp, places))
    if exact_ops:
        # the same result written with fewer decimals is a rounded sum: not accepted without roundSums
        for fr in prim:
            d = Decimal(fr.numerator) / Decimal(fr.denominator)
            if places >= 2 and round_to(d, places - 1, 'u') != d:
                near.add(fixed(round_to(d, places - 1, 'u'), places - 1))
    for y in sorted(near - union):
        ys.append((y, 'untraced'))
    out = []
    for y, expect in ys:
        d = Decimal(y)
        if d == 0 or year_like(y) or y in direct:
            continue
        if any(Decimal(y) == Decimal(x) for x in direct):
            continue
        if not exact_ops and sig_digits(y) < 2:
            continue
        if exact_ops and expect == 'untraced' and scale_of(y) < 1:
            continue
        out.append({'y': y + suffix, 'expect': expect})
    return {'ys': out}


HANDLERS = {'R': case_R, 'A': case_A, 'Q': case_Q, 'T': case_T, 'D': case_D}


def main():
    cases = json.load(sys.stdin)
    json.dump([HANDLERS[c['k']](c) for c in cases], sys.stdout)


if __name__ == '__main__':
    main()
