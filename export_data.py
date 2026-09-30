# -*- coding: utf-8 -*-
"""Export the 4 sheets of the user's workbook to data.json (raw rows, minimal normalization)."""
import openpyxl, json, sys, glob, os

def s(v):
    if v is None: return ''
    if isinstance(v, float) and v.is_integer(): v = int(v)
    return str(v).strip()

def main(path, out):
    wb = openpyxl.load_workbook(path, data_only=True, keep_vba=True)
    data = {"persons": [], "marriages": [], "children": [], "families": []}

    ws = wb['人物表']
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not any(v not in (None, '') for v in r): continue
        data["persons"].append({"id": s(r[0]), "name": s(r[1]), "zi": s(r[2]), "gender": s(r[3]),
                                "family": s(r[4]), "birth": s(r[6]), "death": s(r[7]), "note": s(r[8])})

    ws = wb['婚姻关系表']
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not any(v not in (None, '') for v in r): continue
        data["marriages"].append({"id": s(r[0]), "husbandId": s(r[1]), "husbandName": s(r[2]),
                                  "wifeId": s(r[3]), "wifeName": s(r[4]), "type": s(r[5]), "order": s(r[6])})

    ws = wb['亲子关系表']
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not any(v not in (None, '') for v in r): continue
        data["children"].append({"id": s(r[0]), "childId": s(r[1]), "childName": s(r[2]),
                                 "fatherId": s(r[3]), "fatherName": s(r[4]),
                                 "motherId": s(r[5]), "motherName": s(r[6]),
                                 "rel": s(r[7]), "rank": s(r[8])})

    ws = wb['家族及配色表']
    hdr = [s(c.value) for c in ws[1]]
    ci_name = hdr.index('家族名'); ci_hex = hdr.index('颜色代码提取（Hex）'); ci_txt = hdr.index('字体颜色（黑/白）')
    for r in ws.iter_rows(min_row=2, values_only=True):
        name = s(r[ci_name])
        if not name: continue
        data["families"].append({"name": name, "hex": s(r[ci_hex]), "text": s(r[ci_txt]) or '#000000'})

    json.dump(data, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print({k: len(v) for k, v in data.items()})

if __name__ == '__main__':
    files = sorted(glob.glob('/mnt/user-data/uploads/*.xlsm'), key=os.path.getmtime)
    main(sys.argv[1] if len(sys.argv) > 1 else files[-1], sys.argv[2] if len(sys.argv) > 2 else 'data.json')
